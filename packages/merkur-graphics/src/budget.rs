//! Reservation precedes allocation. Leases charge both bytes and object count,
//! including work in flight and retired objects still referenced by a consumer.

use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Usage {
    pub bytes: usize,
    pub objects: usize,
}

struct State {
    limit: Usage,
    used: Usage,
}

impl State {
    fn new(limit: Usage) -> Self {
        Self {
            limit,
            used: Usage {
                bytes: 0,
                objects: 0,
            },
        }
    }

    fn admitting(&self, charge: Usage) -> Option<Usage> {
        let bytes = self.used.bytes.checked_add(charge.bytes)?;
        let objects = self.used.objects.checked_add(charge.objects)?;
        (bytes <= self.limit.bytes && objects <= self.limit.objects)
            .then_some(Usage { bytes, objects })
    }

    fn refund(&mut self, charge: Usage) {
        self.used.bytes -= charge.bytes;
        self.used.objects -= charge.objects;
    }
}

/// A fixed two-level resource domain. Local budgets cannot escape their shared
/// aggregate or construct cyclic accounting graphs. Admission takes the aggregate
/// lock before the local lock and commits both charges atomically.
pub struct Aggregate(Arc<Mutex<State>>);

impl Aggregate {
    pub fn new(limit: Usage) -> Self {
        Self(Arc::new(Mutex::new(State::new(limit))))
    }

    pub fn partition(&self, limit: Usage) -> Budget {
        Budget {
            state: Arc::new(Mutex::new(State::new(limit))),
            aggregate: Some(Arc::clone(&self.0)),
        }
    }

    pub fn used(&self) -> Option<Usage> {
        self.0.lock().ok().map(|state| state.used)
    }
}

#[derive(Clone)]
pub struct Budget {
    state: Arc<Mutex<State>>,
    aggregate: Option<Arc<Mutex<State>>>,
}

impl Budget {
    pub fn new(limit: Usage) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::new(limit))),
            aggregate: None,
        }
    }

    pub fn reserve(&self, charge: Usage) -> Option<Lease> {
        let mut aggregate = self
            .aggregate
            .as_ref()
            .map(|state| state.lock())
            .transpose()
            .ok()?;
        let aggregate_usage = aggregate.as_ref().map(|state| state.admitting(charge));
        let mut state = self.state.lock().ok()?;
        let usage = state.admitting(charge)?;
        if let Some(aggregate) = &mut aggregate {
            aggregate.used = aggregate_usage.flatten()?;
        }
        state.used = usage;
        Some(Lease {
            budget: self.clone(),
            charge,
        })
    }

    pub fn used(&self) -> Option<Usage> {
        self.state.lock().ok().map(|state| state.used)
    }
}

/// Not Clone: ownership moves; immutable consumers share an Arc holding the lease.
pub struct Lease {
    budget: Budget,
    charge: Usage,
}

impl Lease {
    pub fn charge(&self) -> Usage {
        self.charge
    }

    /// Transfer part of an already admitted batch to a retained object. Aggregate
    /// usage is unchanged; admission cannot race the allocations within a batch.
    pub fn split(&mut self, charge: Usage) -> Option<Self> {
        let bytes = self.charge.bytes.checked_sub(charge.bytes)?;
        let objects = self.charge.objects.checked_sub(charge.objects)?;
        self.charge = Usage { bytes, objects };
        Some(Self {
            budget: self.budget.clone(),
            charge,
        })
    }
    pub fn shrink(&mut self, charge: Usage) -> bool {
        if charge.bytes > self.charge.bytes || charge.objects > self.charge.objects {
            return false;
        }
        let Ok(mut aggregate) = self
            .budget
            .aggregate
            .as_ref()
            .map(|state| state.lock())
            .transpose()
        else {
            return false;
        };
        let Ok(mut state) = self.budget.state.lock() else {
            return false;
        };
        let refund = Usage {
            bytes: self.charge.bytes - charge.bytes,
            objects: self.charge.objects - charge.objects,
        };
        if let Some(aggregate) = &mut aggregate {
            aggregate.refund(refund);
        }
        state.refund(refund);
        self.charge = charge;
        true
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut aggregate = self
            .budget
            .aggregate
            .as_ref()
            .map(|state| state.lock().unwrap_or_else(|error| error.into_inner()));
        let mut state = self
            .budget
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(aggregate) = &mut aggregate {
            aggregate.refund(self.charge);
        }
        state.refund(self.charge);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_transfers_reservations_without_readmission_or_early_refund() {
        let aggregate = Aggregate::new(Usage {
            bytes: 100,
            objects: 4,
        });
        let budget = aggregate.partition(Usage {
            bytes: 100,
            objects: 4,
        });
        let mut batch = budget
            .reserve(Usage {
                bytes: 100,
                objects: 4,
            })
            .unwrap();
        let first = batch
            .split(Usage {
                bytes: 40,
                objects: 2,
            })
            .unwrap();
        assert!(
            batch
                .split(Usage {
                    bytes: 61,
                    objects: 1
                })
                .is_none()
        );
        assert!(
            batch
                .split(Usage {
                    bytes: 1,
                    objects: 3
                })
                .is_none()
        );
        assert_eq!(
            batch.charge(),
            Usage {
                bytes: 60,
                objects: 2
            }
        );
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 100,
                objects: 4
            })
        );
        drop(batch);
        assert_eq!(aggregate.used(), Some(first.charge()));
        assert_eq!(budget.used(), Some(first.charge()));
        drop(first);
        assert_eq!(
            aggregate.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn aggregate_admission_and_refunds_are_atomic_with_local_limits() {
        let empty = Usage {
            bytes: 0,
            objects: 0,
        };
        let aggregate = Aggregate::new(Usage {
            bytes: 10,
            objects: 2,
        });
        let first = aggregate.partition(Usage {
            bytes: 7,
            objects: 1,
        });
        let second = aggregate.partition(Usage {
            bytes: 9,
            objects: 2,
        });
        // A local refusal must not leave a provisional aggregate charge.
        assert!(
            first
                .reserve(Usage {
                    bytes: 8,
                    objects: 1
                })
                .is_none()
        );
        assert_eq!(aggregate.used(), Some(empty));
        let mut a = first
            .reserve(Usage {
                bytes: 7,
                objects: 1,
            })
            .unwrap();
        // An aggregate refusal must not charge the otherwise admissible child.
        assert!(
            second
                .reserve(Usage {
                    bytes: 4,
                    objects: 1
                })
                .is_none()
        );
        assert_eq!(second.used(), Some(empty));
        assert!(!a.shrink(Usage {
            bytes: 8,
            objects: 1
        }));
        assert!(a.shrink(Usage {
            bytes: 3,
            objects: 1
        }));
        assert_eq!(aggregate.used(), first.used());
        let b = Arc::new(
            second
                .reserve(Usage {
                    bytes: 7,
                    objects: 1,
                })
                .unwrap(),
        );
        let retained = Arc::clone(&b);
        drop(b);
        drop(second);
        assert_eq!(
            aggregate.used(),
            Some(Usage {
                bytes: 10,
                objects: 2
            })
        );
        assert!(
            first
                .reserve(Usage {
                    bytes: 0,
                    objects: 1
                })
                .is_none()
        );
        drop(retained);
        drop(a);
        assert_eq!(aggregate.used(), Some(empty));
        assert_eq!(first.used(), Some(empty));
    }

    #[test]
    fn simultaneous_partitions_cannot_overbook_or_refund_retained_owners() {
        use std::sync::Barrier;
        let aggregate = Aggregate::new(Usage {
            bytes: 2,
            objects: 2,
        });
        let admitted = Barrier::new(33);
        let release = Barrier::new(33);
        std::thread::scope(|scope| {
            for _ in 0..32 {
                let admitted = &admitted;
                let release = &release;
                let local = aggregate.partition(Usage {
                    bytes: 1,
                    objects: 1,
                });
                scope.spawn(move || {
                    let lease = local.reserve(Usage {
                        bytes: 1,
                        objects: 1,
                    });
                    drop(local);
                    admitted.wait();
                    release.wait();
                    drop(lease);
                });
            }
            admitted.wait();
            assert_eq!(
                aggregate.used(),
                Some(Usage {
                    bytes: 2,
                    objects: 2
                })
            );
            release.wait();
        });
        assert_eq!(
            aggregate.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn live_and_retired_owners_share_exact_accounting() {
        let budget = Budget::new(Usage {
            bytes: 10,
            objects: 2,
        });
        let a = Arc::new(
            budget
                .reserve(Usage {
                    bytes: 7,
                    objects: 1,
                })
                .unwrap(),
        );
        let retired = a.clone();
        assert!(
            budget
                .reserve(Usage {
                    bytes: 4,
                    objects: 1
                })
                .is_none()
        );
        drop(a);
        assert!(
            budget
                .reserve(Usage {
                    bytes: 4,
                    objects: 1
                })
                .is_none()
        );
        let b = budget
            .reserve(Usage {
                bytes: 3,
                objects: 1,
            })
            .unwrap();
        assert!(
            budget
                .reserve(Usage {
                    bytes: 0,
                    objects: 1
                })
                .is_none()
        );
        drop(retired);
        drop(b);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }
}
