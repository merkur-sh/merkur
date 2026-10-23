use super::*;
use crate::traversal::socket::pinhole_tests::{OwnedPinhole, owned_pinhole};
use futures::future::BoxFuture;
use merkur_client::issuance::{
    Issuance, IssuanceRequest, RenewalCapability, RenewalRequest, StunCredentialRequest,
};

struct PendingIssuer;
impl Issuer for PendingIssuer {
    fn origin(&self) -> &str {
        "https://example.test"
    }
    fn issue(&self, _: IssuanceRequest) -> BoxFuture<'_, Result<Box<Issuance>, AccountError>> {
        Box::pin(std::future::pending())
    }
    fn renew(&self, _: RenewalRequest) -> BoxFuture<'_, Result<RenewalCapability, AccountError>> {
        Box::pin(std::future::pending())
    }
    fn stun(
        &self,
        _: StunCredentialRequest,
    ) -> BoxFuture<'_, Result<crate::traversal::Credential, AccountError>> {
        Box::pin(std::future::pending())
    }
}

fn idle_session() -> Session {
    let certificate = serde_json::from_value(serde_json::json!({
        "userId": "owner", "rootKeyCommitment": "root", "delegationId": "delegate",
        "delegatePublicKey": "key", "scopes": ["terminal-session", "session-revoke"],
        "serverOrigin": "https://example.test", "rootEpoch": 1,
        "issuedAt": 1, "expiresAt": 100_000, "signature": "signature",
    }))
    .unwrap();
    Session::new(
        merkur_client::session::Config {
            browser_node_id: "client".into(),
            relay_only: false,
        },
        merkur_client::auth::Delegation {
            certificate,
            root_public_key: Box::new([0; merkur_authorization::PUBLIC_KEY_BYTES]),
            server_origin: "https://example.test".into(),
        },
    )
}

#[tokio::test]
async fn command_eof_waits_for_router_delete_before_the_driver_can_exit() {
    let OwnedPinhole {
        owner,
        carrier,
        mut received,
        finish_delete,
        serving,
        ..
    } = owned_pinhole(&["AddPinhole", "DeletePinhole"]).await;
    drop(carrier);
    let (commands, input) = Commands::channel();
    drop(commands);
    let (output, _deliveries) = Outputs::channel();
    let delegate = Arc::new(merkur_authorization::SigningKey::from_seed(&mut [5; 32]).unwrap());
    let driver = tokio::spawn(drive_session(
        (idle_session(), owner),
        "daemon",
        Arc::new(PendingIssuer),
        delegate,
        None,
        input,
        output,
    ));
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(3), received.recv())
            .await
            .unwrap(),
        Some("DeletePinhole")
    );
    assert!(
        !driver.is_finished(),
        "EOF must not let the runtime exit while router deletion is pending"
    );
    finish_delete.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), driver)
        .await
        .unwrap()
        .unwrap();
    serving.await.unwrap();
}
