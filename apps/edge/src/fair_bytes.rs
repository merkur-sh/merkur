//! A process-wide byte budget shared fairly between tenants.
//!
//! The relay bounds the bytes its reliable records and finite transfers may
//! hold at once. Each record or transfer reserves its whole length up front and
//! keeps it until it lands, so no transfer ever stalls halfway and no two
//! half-charged transfers can wait on each other. The budget is shared by the
//! tenant each charge names, as the session registry is: while it has room,
//! every charge is granted; full, a charge whose tenant would still hold less
//! than the tenant holding the most closes that tenant's largest held charge's
//! connection, and waits for the bytes to come back. A tenant that would only
//! draw level waits for bytes to free as any other charge lands. No tenant can
//! therefore hold another below an equal share by reserving bytes it never
//! sends.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::Notify;
use wtransport::{Connection, VarInt};

use crate::attach_ticket::Tenant;

/// Why a connection was closed to give its bytes back.
const RECLAIMED_CLOSE_REASON: &[u8] = b"budget-reclaimed";

#[derive(Clone)]
pub(crate) struct FairBytes {
    capacity: usize,
    state: Arc<Mutex<State>>,
    freed: Arc<Notify>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    used: usize,
    /// Bytes whose holders were told to give them back and have not yet.
    reclaiming: usize,
    tenants: HashMap<Tenant, TenantUse>,
}

#[derive(Default)]
struct TenantUse {
    used: usize,
    reclaiming: usize,
    holds: BTreeMap<u64, Hold>,
}

struct Hold {
    bytes: usize,
    /// The connection whose close ends this hold's record or transfer.
    owner: Option<Weak<Connection>>,
    /// Asked to give its bytes back, which it does when its charge drops.
    reclaimed: bool,
}

/// Bytes held for one record or transfer, returned on drop.
pub(crate) struct Charge {
    id: u64,
    tenant: Tenant,
    state: Arc<Mutex<State>>,
    freed: Arc<Notify>,
}

impl Drop for Charge {
    fn drop(&mut self) {
        let mut state = self.state.lock();
        let Some(tenant) = state.tenants.get_mut(&self.tenant) else {
            return;
        };
        let Some(hold) = tenant.holds.remove(&self.id) else {
            return;
        };
        tenant.used -= hold.bytes;
        if hold.reclaimed {
            tenant.reclaiming -= hold.bytes;
        }
        if tenant.holds.is_empty() {
            state.tenants.remove(&self.tenant);
        }
        state.used -= hold.bytes;
        if hold.reclaimed {
            state.reclaiming -= hold.bytes;
        }
        drop(state);
        self.freed.notify_waiters();
    }
}

impl FairBytes {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            state: Arc::new(Mutex::new(State::default())),
            freed: Arc::new(Notify::new()),
        }
    }

    /// Bytes no charge holds.
    #[cfg(test)]
    pub(crate) fn available(&self) -> usize {
        self.capacity - self.state.lock().used
    }

    /// `bytes` for `tenant` now, or `None` when they do not fit. Never takes
    /// another tenant's bytes.
    pub(crate) fn try_charge(
        &self,
        tenant: Tenant,
        bytes: usize,
        owner: Option<&Arc<Connection>>,
    ) -> Option<Charge> {
        let mut state = self.state.lock();
        (state.used + bytes <= self.capacity).then(|| self.grant(&mut state, tenant, bytes, owner))
    }

    /// `bytes` for `tenant` once they fit, taking them back from the tenant
    /// holding the most while `tenant` would still hold less. `None` only when
    /// `bytes` exceeds the whole budget.
    pub(crate) async fn charge(
        &self,
        tenant: Tenant,
        bytes: usize,
        owner: Option<&Arc<Connection>>,
    ) -> Option<Charge> {
        if bytes > self.capacity {
            return None;
        }
        loop {
            // Registered before the check, so a release between the check and
            // the wait still wakes this charge.
            let freed = self.freed.notified();
            tokio::pin!(freed);
            freed.as_mut().enable();
            {
                let mut state = self.state.lock();
                if state.used + bytes <= self.capacity {
                    return Some(self.grant(&mut state, tenant, bytes, owner));
                }
                let shortfall = state.used + bytes - self.capacity;
                state.reclaim_for(tenant, bytes, shortfall);
            }
            freed.await;
        }
    }

    fn grant(
        &self,
        state: &mut State,
        tenant: Tenant,
        bytes: usize,
        owner: Option<&Arc<Connection>>,
    ) -> Charge {
        let id = state.next_id;
        state.next_id += 1;
        state.used += bytes;
        let holder = state.tenants.entry(tenant).or_default();
        holder.used += bytes;
        holder.holds.insert(
            id,
            Hold {
                bytes,
                owner: owner.map(Arc::downgrade),
                reclaimed: false,
            },
        );
        Charge {
            id,
            tenant,
            state: Arc::clone(&self.state),
            freed: Arc::clone(&self.freed),
        }
    }
}

impl State {
    /// Ask the tenant holding the most to give back enough for `tenant`'s
    /// `bytes`, largest hold first, while `tenant` would still hold less than
    /// it. Bytes already being given back count toward the shortfall.
    fn reclaim_for(&mut self, tenant: Tenant, bytes: usize, shortfall: usize) {
        let own = self.tenants.get(&tenant).map_or(0, |held| held.used);
        while self.reclaiming < shortfall {
            let Some((heaviest, held)) = self
                .tenants
                .iter()
                .filter(|(candidate, _)| **candidate != tenant)
                .map(|(candidate, held)| (*candidate, held.used - held.reclaiming))
                .max_by_key(|(_, held)| *held)
            else {
                return;
            };
            if own + bytes >= held {
                return;
            }
            let Some(holder) = self.tenants.get_mut(&heaviest) else {
                return;
            };
            let Some(hold) = holder
                .holds
                .values_mut()
                .filter(|hold| !hold.reclaimed)
                .max_by_key(|hold| hold.bytes)
            else {
                return;
            };
            hold.reclaimed = true;
            let given = hold.bytes;
            let owner = hold.owner.as_ref().and_then(Weak::upgrade);
            holder.reclaiming += given;
            self.reclaiming += given;
            if let Some(connection) = owner {
                connection.close(VarInt::from_u32(0), RECLAIMED_CLOSE_REASON);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::task::{Context, Waker};

    fn tenant(account: &str) -> Tenant {
        crate::attach_ticket::test_key().tenant(account)
    }

    #[tokio::test]
    async fn a_budget_with_room_grants_and_takes_back_on_drop() {
        let budget = FairBytes::with_capacity(10);
        let charge = budget.try_charge(tenant("a"), 6, None).unwrap();
        assert_eq!(budget.available(), 4);
        assert!(budget.try_charge(tenant("b"), 5, None).is_none());
        drop(charge);
        assert_eq!(budget.available(), 10);
        assert!(budget.charge(tenant("a"), 11, None).await.is_none());
    }

    #[tokio::test]
    async fn a_lighter_tenant_takes_bytes_back_from_the_heaviest() {
        let budget = FairBytes::with_capacity(10);
        let heavy_small = budget.try_charge(tenant("heavy"), 4, None).unwrap();
        let heavy_large = budget.try_charge(tenant("heavy"), 6, None).unwrap();
        let waiting = budget.charge(tenant("light"), 3, None);
        tokio::pin!(waiting);
        assert!(
            waiting
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        {
            let state = budget.state.lock();
            assert_eq!(state.reclaiming, 6, "the largest hold is asked first");
            assert!(
                state.tenants[&tenant("heavy")]
                    .holds
                    .values()
                    .any(|hold| hold.bytes == 6 && hold.reclaimed)
            );
        }
        drop(heavy_large);
        let light = waiting.await.unwrap();
        assert_eq!(budget.available(), 3);
        drop((light, heavy_small));
        assert_eq!(budget.available(), 10);
        assert_eq!(budget.state.lock().reclaiming, 0);
    }

    #[tokio::test]
    async fn a_tenant_that_would_draw_level_waits_instead_of_taking() {
        let budget = FairBytes::with_capacity(10);
        let first = budget.try_charge(tenant("first"), 5, None).unwrap();
        let _second = budget.try_charge(tenant("second"), 5, None).unwrap();
        let waiting = budget.charge(tenant("second"), 1, None);
        tokio::pin!(waiting);
        assert!(
            waiting
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        assert_eq!(budget.state.lock().reclaiming, 0);
        drop(first);
        waiting.await.unwrap();
    }
}
