//! Native account management uses the same records and routes as the browser.
use super::{Account, AccountError, Credentials, UnlockedRoot, json};
use merkur_authorization::{
    DelegationCertificate, MAX_SAFE_INTEGER, MlDsa87Signer, RevocationPayload,
    RevocationStatement, RevocationTarget, encode,
};
use merkur_client::{Entropy, auth::Delegation};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Client {
    #[serde(deserialize_with = "super::devices::nullable")]
    pub browser: Option<String>,
    #[serde(deserialize_with = "super::devices::nullable")]
    pub platform: Option<String>,
    pub installed: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub delegation_id: String,
    pub issued_at: u64,
    pub expires_at: u64,
    #[serde(deserialize_with = "super::devices::nullable")]
    pub revoked_at: Option<u64>,
    pub current: bool,
    pub client: Client,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sessions {
    pub server_time_ms: u64,
    pub sessions: Vec<Session>,
}
impl Sessions {
    fn valid(&self) -> bool {
        fn name(value: &Option<String>) -> bool {
            value
                .as_ref()
                .is_none_or(|value| !value.is_empty() && value.encode_utf16().count() <= 32)
        }
        self.server_time_ms <= MAX_SAFE_INTEGER
            && self.sessions.iter().all(|session| {
                !session.delegation_id.is_empty()
                    && session.issued_at <= MAX_SAFE_INTEGER
                    && session.expires_at <= MAX_SAFE_INTEGER
                    && session.revoked_at.is_none_or(|at| at <= MAX_SAFE_INTEGER)
                    && name(&session.client.browser)
                    && name(&session.client.platform)
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    pub actor_certificate: DelegationCertificate,
    pub revocation: RevocationStatement,
}
impl Revocation {
    /// Signed by `delegate`, the key `delegation` certifies. A hardware key
    /// signs for milliseconds: call this off any reactor that carries input.
    pub fn create(
        delegation: &Delegation,
        delegate: &dyn MlDsa87Signer,
        mut targets: Vec<RevocationTarget>,
        issued_at: u64,
        entropy: &mut impl Entropy,
    ) -> Result<Self, AccountError> {
        targets.sort_unstable_by(|left, right| left.delegation_id.cmp(&right.delegation_id));
        let certificate = &delegation.certificate;
        let revocation = RevocationStatement::create(
            RevocationPayload {
                user_id: certificate.user_id.clone(),
                root_key_commitment: certificate.root_key_commitment.clone(),
                actor_delegation_id: certificate.delegation_id.clone(),
                targets,
                issued_at,
                nonce: encode(&entropy.array::<32>()),
            },
            delegate,
            entropy.array(),
        )
        .map_err(|_| AccountError::Invalid("revocation"))?;
        Ok(Self {
            actor_certificate: certificate.clone(),
            revocation,
        })
    }
}
/// A claim authenticated by the out-of-band code, ready for the user to review.
/// Its link secret stays owned and wiped; it is never sent to the server.
pub struct VerifiedLink {
    pub claim: merkur_authorization::LinkPublicClaim,
    server_nonce: [u8; 32],
    server_time_ms: u64,
    origin: String,
    secret: Zeroizing<[u8; 32]>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OkResponse {
    ok: bool,
}

impl Account {
    pub async fn inspect_link(
        &self,
        access_token: &str,
        code: Zeroizing<String>,
    ) -> Result<VerifiedLink, AccountError> {
        let (id, secret) = merkur_authorization::parse_link_code(&code)
            .map_err(|_| AccountError::Invalid("link code"))?;
        let secret = Zeroizing::new(secret);
        drop(code);
        let response = self
            .send(
                &format!("/api/daemon-link/claims/{}/inspect", segment(&id)?),
                Some(b"{}".to_vec()),
                Some(access_token),
                None,
            )
            .await?;
        let mut value: serde_json::Map<String, serde_json::Value> = response.json().await?;
        let nonce = value
            .remove("serverNonce")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or(AccountError::Invalid("link nonce"))?;
        let server_nonce = merkur_authorization::decode_exact::<32>(&nonce, "link nonce")
            .map_err(|_| AccountError::Invalid("link nonce"))?;
        let server_time_ms = value
            .remove("serverTimeMs")
            .and_then(|value| value.as_u64())
            .filter(|time| *time <= MAX_SAFE_INTEGER)
            .ok_or(AccountError::Invalid("link time"))?;
        let claim: merkur_authorization::LinkPublicClaim =
            serde_json::from_value(serde_json::Value::Object(value))
                .map_err(|_| AccountError::Invalid("link claim"))?;
        if claim.link_claim_id != id {
            return Err(AccountError::Invalid("link claim id"));
        }
        claim
            .verify(&secret)
            .map_err(|_| AccountError::Invalid("link claim commitment"))?;
        Ok(VerifiedLink {
            claim,
            server_nonce,
            server_time_ms,
            secret,
            origin: self.origin.clone(),
        })
    }

    pub async fn approve_link(
        &self,
        credentials: &Credentials,
        link: VerifiedLink,
        root: UnlockedRoot,
        entropy: &mut impl Entropy,
    ) -> Result<(), AccountError> {
        use merkur_authorization::{
            DaemonBinding, DaemonBindingPayload, LinkApproval, LinkApprovalPayload,
            root_key_commitment,
        };
        if link.origin != self.origin || root.origin != self.origin {
            return Err(AccountError::Invalid("link origin"));
        }
        // Review and password entry may outlive the inspect nonce. Obtain a
        // fresh challenge and prove it still names exactly the reviewed claim.
        let reviewed = &link;
        let link = self
            .authorized(credentials, |token| async move {
                let code = merkur_authorization::format_link_code(
                    &reviewed.claim.link_claim_id,
                    &reviewed.secret,
                )
                .map_err(|_| AccountError::Invalid("link code"))?;
                let fresh = self.inspect_link(&token, Zeroizing::new(code)).await?;
                if fresh.claim != reviewed.claim {
                    return Err(AccountError::Invalid("reviewed link claim changed"));
                }
                Ok(fresh)
            })
            .await?;
        let claim = &link.claim;
        let daemon_binding = DaemonBinding::create(
            DaemonBindingPayload {
                user_id: root.user_id,
                root_key_commitment: root_key_commitment(&*root.public_key)
                    .map_err(|_| AccountError::Invalid("root public key"))?,
                daemon_id: claim.daemon_id.clone(),
                daemon_identity_key_commitment: claim.daemon_identity_key_commitment.clone(),
                server_origin: self.origin.clone(),
                link_claim_id: claim.link_claim_id.clone(),
                issued_at: link.server_time_ms,
            },
            &root.key,
            entropy.array(),
        )
        .map_err(|_| AccountError::Invalid("daemon binding"))?;
        let approval = LinkApproval::create(
            LinkApprovalPayload {
                link_claim_id: claim.link_claim_id.clone(),
                claim_commitment: claim.claim_commitment.clone(),
                user_root_public_key: encode(&*root.public_key),
                root_epoch: root.root_epoch,
                daemon_binding,
            },
            &link.server_nonce,
            &link.secret,
        )
        .map_err(|_| AccountError::Invalid("link approval"))?;
        drop(root.key);
        let approval = &approval;
        let claim = &link.claim;
        self.authorized(credentials, |token| async move {
            let response = self
                .send(
                    &format!(
                        "/api/daemon-link/claims/{}/approve",
                        segment(&claim.link_claim_id)?
                    ),
                    Some(json(&approval)?),
                    Some(&token),
                    None,
                )
                .await?;
            let answer: OkResponse = response.json().await?;
            if answer.ok {
                Ok(())
            } else {
                Err(AccountError::Invalid("link approval response"))
            }
        })
        .await
    }

    pub async fn sessions(&self, access_token: &str) -> Result<Sessions, AccountError> {
        let response = self
            .request(
                Method::GET,
                "/api/browser-sessions",
                None,
                Some(access_token),
                None,
            )
            .await?;
        let sessions: Sessions = response.json().await?;
        if sessions.valid() {
            Ok(sessions)
        } else {
            Err(AccountError::Invalid("account sessions"))
        }
    }
    pub async fn rename(
        &self,
        access_token: &str,
        id: &str,
        name: &str,
    ) -> Result<(), AccountError> {
        #[derive(Serialize)]
        struct Rename<'a> {
            name: &'a str,
        }
        let response = self
            .request(
                Method::PATCH,
                &format!("/api/devices/{}", segment(id)?),
                Some(json(&Rename { name })?),
                Some(access_token),
                None,
            )
            .await?;
        if response.status() == 204 {
            Ok(())
        } else {
            Err(AccountError::Invalid("rename response"))
        }
    }
    pub async fn unlink(&self, access_token: &str, id: &str) -> Result<(), AccountError> {
        let response = self
            .request(
                Method::DELETE,
                &format!("/api/devices/{}", segment(id)?),
                None,
                Some(access_token),
                None,
            )
            .await?;
        if response.status() == 204 {
            Ok(())
        } else {
            Err(AccountError::Invalid("unlink response"))
        }
    }
    pub async fn revoke(
        &self,
        access_token: &str,
        id: &str,
        authorization: &Revocation,
    ) -> Result<(), AccountError> {
        let response = self
            .request(
                Method::DELETE,
                &format!("/api/browser-sessions/{}", segment(id)?),
                Some(json(authorization)?),
                Some(access_token),
                None,
            )
            .await?;
        let answer: OkResponse = response.json().await?;
        if answer.ok {
            Ok(())
        } else {
            Err(AccountError::Invalid("revocation response"))
        }
    }
}

fn segment(id: &str) -> Result<String, AccountError> {
    if id.is_empty() {
        return Err(AccountError::Invalid("account resource id"));
    }
    let mut encoded = String::new();
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("string writes cannot fail");
        }
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_ids_cannot_change_the_route() {
        assert_eq!(segment("a/b?c#é").unwrap(), "a%2Fb%3Fc%23%C3%A9");
        assert!(segment("").is_err());
    }
    #[test]
    fn nullable_session_fields_are_present_and_names_keep_the_wire_bound() {
        let row = r#"{"serverTimeMs":1,"sessions":[{"delegationId":"device","issuedAt":1,"expiresAt":2,"revokedAt":null,"current":true,"client":{"browser":null,"platform":"macOS","installed":false}}]}"#;
        let mut sessions: Sessions = serde_json::from_str(row).unwrap();
        assert!(sessions.valid());
        sessions.sessions[0].client.browser = Some("😀".repeat(17));
        assert!(!sessions.valid());
        assert!(serde_json::from_str::<Sessions>(&row.replace("\"revokedAt\":null,", "")).is_err());
    }
}
