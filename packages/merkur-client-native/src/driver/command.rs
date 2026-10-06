//! Finite command ownership, with input and display grants independent of control.
use super::Command;
use crate::credit::{Credit, Lease};
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Commands {
    senders: [mpsc::UnboundedSender<CommandDelivery>; 3],
    credits: [Credit; 3],
}
#[derive(Debug)]
pub struct CommandSendError;
pub struct CommandDelivery {
    command: Command,
    lease: Lease,
}
impl CommandDelivery {
    pub fn into_parts(self) -> (Command, Lease) {
        (self.command, self.lease)
    }
}
pub struct CommandReceiver {
    pub(super) input: mpsc::UnboundedReceiver<CommandDelivery>,
    pub(super) control: mpsc::UnboundedReceiver<CommandDelivery>,
    pub(super) pulse: mpsc::UnboundedReceiver<CommandDelivery>,
}
impl Commands {
    pub fn channel() -> (Self, CommandReceiver) {
        let (input, input_rx) = mpsc::unbounded_channel();
        let (control, control_rx) = mpsc::unbounded_channel();
        let (pulse, pulse_rx) = mpsc::unbounded_channel();
        (
            Self {
                senders: [input, control, pulse],
                credits: std::array::from_fn(|_| Credit::new(4096, 64 * 1024 * 1024)),
            },
            CommandReceiver {
                input: input_rx,
                control: control_rx,
                pulse: pulse_rx,
            },
        )
    }
    pub fn is_closed(&self) -> bool {
        self.senders[0].is_closed()
    }
    pub fn send(&self, command: Command) -> Result<(), CommandSendError> {
        let index = match &command {
            Command::Input { .. } => 0,
            Command::DisplayAck { .. } => 2,
            _ => 1,
        };
        let bytes = std::mem::size_of::<CommandDelivery>()
            + match &command {
                Command::Input { record, .. } => record.capacity(),
                Command::ResyncRows { rows, .. } => rows.capacity() * std::mem::size_of::<u16>(),
                Command::DisplayResume(resume) => resume
                    .row_hashes
                    .as_ref()
                    .map_or(0, |hashes| hashes.capacity() * 8),
                Command::GraphicsDemand { demands, .. } => {
                    demands.capacity()
                        * std::mem::size_of::<merkur_client::session::graphics::GraphicsDemand>()
                        + demands
                            .iter()
                            .map(|demand| demand.key.capacity())
                            .sum::<usize>()
                }
                _ => 0,
            };
        let lease = self.credits[index]
            .try_reserve(bytes)
            .map_err(|_| CommandSendError)?;
        self.senders[index]
            .send(CommandDelivery { command, lease })
            .map_err(|_| CommandSendError)
    }
}
impl CommandReceiver {
    pub fn close(&mut self) {
        self.input.close();
        self.control.close();
        self.pulse.close();
    }
    pub fn try_recv(&mut self) -> Result<CommandDelivery, mpsc::error::TryRecvError> {
        self.input
            .try_recv()
            .or_else(|_| self.pulse.try_recv())
            .or_else(|_| self.control.try_recv())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn full_control_commands_keep_input_and_ack_admission_independent() {
        let (commands, mut incoming) = Commands::channel();
        for _ in 0..4096 {
            commands.send(Command::Focused(true)).unwrap();
        }
        assert!(commands.send(Command::Focused(false)).is_err());
        commands
            .send(Command::Input {
                local_seq: 1,
                record: vec![1, 2],
                modelled: true,
            })
            .unwrap();
        commands
            .send(Command::DisplayAck {
                payload: merkur_wire::protocol::DisplayAckPayload {
                    generation: 1,
                    largest_seq: 1,
                    received: [1, 0, 0, 0],
                    recovered: [0; 4],
                    grant: 2,
                },
                durable: true,
            })
            .unwrap();
        assert!(matches!(
            incoming.input.recv().await.unwrap().into_parts().0,
            Command::Input { local_seq: 1, .. }
        ));
        assert!(matches!(
            incoming.pulse.recv().await.unwrap().into_parts().0,
            Command::DisplayAck { .. }
        ));
        let held = incoming.control.recv().await.unwrap();
        assert!(commands.send(Command::Focused(false)).is_err());
        drop(held);
        commands.send(Command::Focused(false)).unwrap();
        incoming.close();
        assert!(commands.is_closed());
        assert!(
            commands
                .send(Command::Input {
                    local_seq: 2,
                    record: vec![3],
                    modelled: false
                })
                .is_err()
        );
    }
}
