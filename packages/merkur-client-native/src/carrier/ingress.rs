//! Each logical ingress lane owns separate count and byte admission credits.
use tokio::sync::mpsc;

use super::{Finite, Inbound};
use crate::credit::{Credit, Lease};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lane {
    Control = 0,
    Display = 1,
    Pulse = 2,
    Lifecycle = 3,
}

#[derive(Clone)]
pub struct InboundSender {
    senders: [mpsc::UnboundedSender<InboundDelivery>; 4],
    credits: [Credit; 4],
    lane: Lane,
}

pub(crate) struct InboundReceivers {
    pub control: mpsc::UnboundedReceiver<InboundDelivery>,
    pub display: mpsc::UnboundedReceiver<InboundDelivery>,
    pub pulse: mpsc::UnboundedReceiver<InboundDelivery>,
    pub lifecycle: mpsc::UnboundedReceiver<InboundDelivery>,
}

pub struct InboundDelivery {
    inbound: Inbound,
    lease: Lease,
}

impl InboundDelivery {
    pub(crate) fn into_parts(self) -> (Inbound, Lease) {
        (self.inbound, self.lease)
    }
}

impl InboundSender {
    pub(crate) fn channel() -> (Self, InboundReceivers) {
        let (control, control_rx) = mpsc::unbounded_channel();
        let (display, display_rx) = mpsc::unbounded_channel();
        let (pulse, pulse_rx) = mpsc::unbounded_channel();
        let (lifecycle, lifecycle_rx) = mpsc::unbounded_channel();
        (
            Self {
                senders: [control, display, pulse, lifecycle],
                credits: [
                    Credit::new(64, 64 * 1024 * 1024),
                    Credit::new(64, 64 * 1024 * 1024),
                    Credit::new(64, 4 * 1024 * 1024),
                    Credit::new(16, 16 * std::mem::size_of::<InboundDelivery>()),
                ],
                lane: Lane::Control,
            },
            InboundReceivers {
                control: control_rx,
                display: display_rx,
                pulse: pulse_rx,
                lifecycle: lifecycle_rx,
            },
        )
    }

    pub(super) fn lane(&self, lane: Lane) -> Self {
        Self {
            lane,
            ..self.clone()
        }
    }

    pub(super) fn channel_lane(&self, channel: u8) -> Self {
        use merkur_wire::protocol::{
            CHANNEL_DISPLAY_COMMIT, CHANNEL_DISPLAY_DATAGRAM, CHANNEL_GRAPHICS_CONTENT,
        };
        self.lane(
            if channel & 0x7f == CHANNEL_DISPLAY_COMMIT
                || channel & 0x7f == CHANNEL_DISPLAY_DATAGRAM
                || channel & 0x7f == CHANNEL_GRAPHICS_CONTENT
            {
                Lane::Display
            } else {
                Lane::Control
            },
        )
    }

    pub(super) async fn reserve(&self, bytes: usize) -> Option<Lease> {
        let index = self.lane as usize;
        tokio::select! {
            lease = self.credits[index].reserve(bytes + std::mem::size_of::<InboundDelivery>()) => lease,
            () = self.senders[index].closed() => None,
        }
    }

    pub(super) fn publish(&self, inbound: Inbound, lease: Lease) -> bool {
        self.senders[self.lane as usize]
            .send(InboundDelivery { inbound, lease })
            .is_ok()
    }

    pub(super) async fn send(&self, inbound: Inbound) -> bool {
        let bytes = match &inbound {
            Inbound::Reliable { payload, .. } | Inbound::Proof { payload, .. } => {
                payload.capacity()
            }
            Inbound::Datagram { payload, .. } => payload.len(),
            Inbound::Finite {
                part: Finite::Data(bytes),
                ..
            } => bytes.capacity(),
            _ => 0,
        };
        match self.reserve(bytes).await {
            Some(lease) => self.publish(inbound, lease),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exhausted_display_count_and_bytes_do_not_spend_control_or_pulse_credit() {
        let (sender, mut received) = InboundSender::channel();
        let display = sender.lane(Lane::Display);
        let held = display
            .reserve(64 * 1024 * 1024 - std::mem::size_of::<InboundDelivery>())
            .await
            .unwrap();
        let mut blocked = Box::pin(display.reserve(1));
        assert!(futures::poll!(&mut blocked).is_pending());
        assert!(
            sender
                .send(Inbound::Closed {
                    conn: merkur_client::session::ConnId(1),
                    egress_budget: false
                })
                .await
        );
        assert!(
            sender
                .lane(Lane::Pulse)
                .send(Inbound::Datagram {
                    conn: merkur_client::session::ConnId(1),
                    payload: bytes::Bytes::from_static(b"ack")
                })
                .await
        );
        drop(received.control.recv().await.unwrap());
        drop(received.pulse.recv().await.unwrap());
        assert!(futures::poll!(&mut blocked).is_pending());
        drop(held);
        assert!(blocked.await.is_some());
    }
}
