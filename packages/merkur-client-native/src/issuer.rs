//! Where a session's issuances and renewal capabilities come from: the
//! account API in a client, an in-process issuer in the network simulator.

use std::sync::Arc;

use futures::future::BoxFuture;
use merkur_client::issuance::{Issuance, IssuanceRequest, RenewalCapability, RenewalRequest};

use crate::account::{Account, AccountError, Credentials};

pub trait Issuer: Send + Sync {
    /// The server origin every edge attachment presents.
    fn origin(&self) -> &str;
    fn issue(&self, request: IssuanceRequest)
    -> BoxFuture<'_, Result<Box<Issuance>, AccountError>>;
    fn renew(
        &self,
        request: RenewalRequest,
    ) -> BoxFuture<'_, Result<RenewalCapability, AccountError>>;
}

/// The account API, its access token renewed once when the server refuses it.
pub struct AccountIssuer {
    pub account: Arc<Account>,
    pub credentials: Arc<Credentials>,
}

impl Issuer for AccountIssuer {
    fn origin(&self) -> &str {
        self.account.origin()
    }

    fn issue(
        &self,
        request: IssuanceRequest,
    ) -> BoxFuture<'_, Result<Box<Issuance>, AccountError>> {
        Box::pin(async move {
            let (account, request) = (&self.account, &request);
            account
                .authorized(&self.credentials, |token| async move {
                    account.request_issuance(&token, request).await
                })
                .await
        })
    }

    fn renew(
        &self,
        request: RenewalRequest,
    ) -> BoxFuture<'_, Result<RenewalCapability, AccountError>> {
        Box::pin(async move {
            let (account, request) = (&self.account, &request);
            account
                .authorized(&self.credentials, |token| async move {
                    account.request_renewal(&token, request).await
                })
                .await
        })
    }
}
