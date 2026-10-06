//! The account client against a server that answers from a script.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

/// What the server was sent: the request line and the `Cookie` header.
type Received = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// A server answering each request, one per connection, with the next of
/// `answers`.
async fn serve(answers: Vec<String>) -> (Account, Received) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let received: Received = Arc::default();
    let log = Arc::clone(&received);
    tokio::spawn(async move {
        for answer in answers {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..read]);
            }
            let text = String::from_utf8_lossy(&request).to_string();
            let line = text.lines().next().unwrap_or_default().to_string();
            let cookie = text
                .lines()
                .find_map(|header| header.strip_prefix("cookie: "))
                .map(str::to_string);
            log.lock().unwrap().push((line, cookie));
            stream.write_all(answer.as_bytes()).await.unwrap();
        }
    });
    let account = Account::new(&origin, [0; SERVER_PUBLIC_KEY_BYTES]).unwrap();
    (account, received)
}

fn refreshed(access_token: &str, delegation_id: &str, cookie: &str) -> String {
    let body = format!(
        r#"{{"accessToken":"{access_token}","userId":"user","delegationId":"{delegation_id}","delegationExpiresAt":1,"serverTimeMs":1,"deletionCancelled":false}}"#
    );
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nset-cookie: merkur_refresh={cookie}; Path=/; HttpOnly\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn credentials() -> Credentials {
    let session = AccountSession {
        access_token: "a1".to_string(),
        user_id: "user".to_string(),
        delegation_id: "device".to_string(),
        delegation_expires_at: 1,
        server_time_ms: 1,
        deletion_cancelled: false,
    };
    Credentials::new(
        &session,
        RefreshCredential::from_value(Zeroizing::new("r1".into())),
    )
}

/// A request the server accepts only with `valid`, counting attempts.
#[expect(
    clippy::unused_async,
    reason = "`Account::authorized` takes a request that returns a future"
)]
async fn guarded(
    token: Arc<str>,
    valid: &str,
    calls: &AtomicUsize,
) -> Result<String, AccountError> {
    calls.fetch_add(1, Ordering::SeqCst);
    if *token == *valid {
        Ok(token.to_string())
    } else {
        Err(AccountError::Refused {
            status: 401,
            code: "unauthorized".to_string(),
        })
    }
}

#[tokio::test]
async fn a_refused_token_is_renewed_once_and_the_request_repeated() {
    let (account, received) = serve(vec![
        refreshed("a2", "device", "r2"),
        refreshed("a3", "device", "r3"),
    ])
    .await;
    let credentials = credentials();
    let calls = AtomicUsize::new(0);
    let answer = account
        .authorized(&credentials, |token| guarded(token, "a2", &calls))
        .await;
    assert_eq!(answer.unwrap(), "a2");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // The next renewal spends the rotated credential.
    let answer = account
        .authorized(&credentials, |token| guarded(token, "a3", &calls))
        .await;
    assert_eq!(answer.unwrap(), "a3");
    let received = received.lock().unwrap().clone();
    assert_eq!(
        received,
        [
            (
                "POST /api/auth/refresh HTTP/1.1".to_string(),
                Some("merkur_refresh=r1".to_string())
            ),
            (
                "POST /api/auth/refresh HTTP/1.1".to_string(),
                Some("merkur_refresh=r2".to_string())
            ),
        ]
    );
}

#[tokio::test]
async fn requests_refused_together_spend_the_credential_once() {
    let (account, received) = serve(vec![refreshed("a2", "device", "r2")]).await;
    let credentials = credentials();
    let calls = AtomicUsize::new(0);
    let (first, second) = tokio::join!(
        account.authorized(&credentials, |token| guarded(token, "a2", &calls)),
        account.authorized(&credentials, |token| guarded(token, "a2", &calls)),
    );
    assert_eq!(
        (first.unwrap(), second.unwrap()),
        ("a2".into(), "a2".into())
    );
    assert_eq!(received.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn any_other_failure_is_not_repeated() {
    let (account, received) = serve(Vec::new()).await;
    let calls = &AtomicUsize::new(0);
    let answer: Result<(), _> = account
        .authorized(&credentials(), |_| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(AccountError::Refused {
                status: 503,
                code: "unavailable".to_string(),
            })
        })
        .await;
    assert!(matches!(
        answer,
        Err(AccountError::Refused { status: 503, .. })
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(received.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_renewal_for_another_delegation_is_refused() {
    let (account, _) = serve(vec![refreshed("a2", "someone-else", "r2")]).await;
    let calls = AtomicUsize::new(0);
    let answer = account
        .authorized(&credentials(), |token| guarded(token, "a2", &calls))
        .await;
    assert!(matches!(
        answer,
        Err(AccountError::Invalid("account session"))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

struct Stored {
    renewals: AtomicUsize,
    refuse_storage: bool,
}
impl CredentialSource for Stored {
    fn current(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Arc<str>, AccountError>> + Send + '_>> {
        Box::pin(async move {
            if self.refuse_storage {
                Err(AccountError::Invalid("credential storage"))
            } else {
                Ok(Arc::from("stored-a1"))
            }
        })
    }
    fn renewed<'a>(
        &'a self,
        account: &'a Account,
        refused: Arc<str>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Arc<str>, AccountError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(account.origin(), "http://localhost:3000");
            assert_eq!(&*refused, "stored-a1");
            self.renewals.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::from("stored-a2"))
        })
    }
}
#[tokio::test]
async fn stored_credentials_renew_only_after_401_and_never_use_ephemeral_tokens() {
    let account = Account::new("http://localhost:3000", [0; 32]).unwrap();
    let source = Arc::new(Stored {
        renewals: AtomicUsize::new(0),
        refuse_storage: false,
    });
    let session = AccountSession {
        access_token: "must-never-be-used".into(),
        user_id: "user".into(),
        delegation_id: "device".into(),
        delegation_expires_at: 1,
        server_time_ms: 1,
        deletion_cancelled: false,
    };
    let credentials = Credentials::stored(&session, source.clone());
    let calls = AtomicUsize::new(0);
    assert_eq!(
        account
            .authorized(&credentials, |token| guarded(token, "stored-a2", &calls))
            .await
            .unwrap(),
        "stored-a2"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(source.renewals.load(Ordering::SeqCst), 1);
    let answer: Result<(), _> = account
        .authorized(&credentials, |_| async {
            Err(AccountError::Refused {
                status: 503,
                code: "unavailable".into(),
            })
        })
        .await;
    assert!(matches!(
        answer,
        Err(AccountError::Refused { status: 503, .. })
    ));
    assert_eq!(source.renewals.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn stored_credentials_fail_closed_before_any_request_when_storage_is_unavailable() {
    let account = Account::new("http://localhost:3000", [0; 32]).unwrap();
    let source = Arc::new(Stored {
        renewals: AtomicUsize::new(0),
        refuse_storage: true,
    });
    let session = AccountSession {
        access_token: "must-never-be-used".into(),
        user_id: "user".into(),
        delegation_id: "device".into(),
        delegation_expires_at: 1,
        server_time_ms: 1,
        deletion_cancelled: false,
    };
    let credentials = Credentials::stored(&session, source.clone());
    let calls = AtomicUsize::new(0);
    let answer = account
        .authorized(&credentials, |token| {
            guarded(token, "must-never-be-used", &calls)
        })
        .await;
    assert!(matches!(
        answer,
        Err(AccountError::Invalid("credential storage"))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(source.renewals.load(Ordering::SeqCst), 0);
}
