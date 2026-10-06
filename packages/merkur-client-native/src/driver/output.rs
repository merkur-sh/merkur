//! Host deliveries retain their count and byte credits through forwarding.
use merkur_client::session::Action;
use tokio::sync::mpsc;

use super::Output;
use crate::credit::{Credit, Lease};

pub struct Delivery {
    output: Output,
    lease: Lease,
}

impl Delivery {
    /// The consumer holds the lease through applying the output. Forwarders
    /// move the whole delivery rather than releasing producer credits early.
    pub fn into_parts(self) -> (Output, Lease) {
        (self.output, self.lease)
    }
}

pub struct Outputs {
    sender: mpsc::UnboundedSender<Delivery>,
    credit: Credit,
}

impl Outputs {
    pub fn channel() -> (Self, mpsc::UnboundedReceiver<Delivery>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (
            Self {
                sender,
                credit: Credit::new(64, 64 * 1024 * 1024),
            },
            receiver,
        )
    }

    pub(super) fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }

    pub(super) fn try_reserve(&self, bytes: usize) -> Option<Lease> {
        self.credit.try_reserve(bytes).ok()
    }

    pub(super) async fn reserve(&self, bytes: usize) -> Option<Lease> {
        tokio::select! {
            lease = self.credit.reserve(bytes) => lease,
            () = self.sender.closed() => None,
        }
    }

    pub(super) fn publish(&self, output: Output, lease: Lease) -> bool {
        self.sender.send(Delivery { output, lease }).is_ok()
    }
}

pub(super) fn action_bytes(action: &Action) -> usize {
    action.host_resident_bytes() - std::mem::size_of::<Action>() + std::mem::size_of::<Delivery>()
}

pub(super) fn error_bytes(error: &crate::account::AccountError) -> usize {
    use crate::account::AccountError;
    std::mem::size_of::<Delivery>()
        + match error {
            AccountError::Refused { code, .. } => code.capacity(),
            AccountError::Unreachable(reason) => reason.capacity(),
            _ => 0,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_wire::terminal_ui::TerminalUi;

    #[tokio::test]
    async fn a_forwarded_delivery_still_owns_both_producer_credits() {
        let bytes = std::mem::size_of::<Delivery>() + 32;
        let (sender, mut first) = mpsc::unbounded_channel();
        let outputs = Outputs {
            sender,
            credit: Credit::new(1, bytes),
        };
        let lease = outputs.try_reserve(bytes).unwrap();
        assert!(outputs.publish(
            Output::TerminalUi(TerminalUi::Title("remote".into())),
            lease
        ));
        let delivery = first.recv().await.unwrap();
        assert!(outputs.try_reserve(1).is_none());
        let (forward, mut ui) = mpsc::unbounded_channel();
        forward
            .send(delivery)
            .unwrap_or_else(|_| panic!("open UI queue"));
        assert!(outputs.try_reserve(1).is_none());
        let (output, lease) = ui.recv().await.unwrap().into_parts();
        assert!(outputs.try_reserve(1).is_none());
        assert!(
            matches!(output, Output::TerminalUi(TerminalUi::Title(title)) if title == "remote")
        );
        drop(lease);
        assert!(outputs.try_reserve(bytes).is_some());
    }

    #[tokio::test]
    async fn retiring_a_forwarding_queue_releases_unread_sensitive_deliveries() {
        let bytes = std::mem::size_of::<Delivery>() + 32;
        let (sender, mut first) = mpsc::unbounded_channel();
        let outputs = Outputs {
            sender,
            credit: Credit::new(1, bytes),
        };
        let lease = outputs.try_reserve(bytes).unwrap();
        assert!(outputs.publish(
            Output::TerminalUi(TerminalUi::Clipboard {
                selection: b'c',
                text: zeroize::Zeroizing::new("private clipboard".into()),
            }),
            lease
        ));
        let (forward, ui) = mpsc::unbounded_channel();
        forward
            .send(first.recv().await.unwrap())
            .unwrap_or_else(|_| panic!("open UI queue"));
        assert!(outputs.try_reserve(1).is_none());
        drop(ui);
        assert!(outputs.try_reserve(bytes).is_some());
    }
}
