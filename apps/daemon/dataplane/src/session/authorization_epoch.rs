//! A signed authorization deadline and a non-renewable allowance within it.

pub(crate) struct AuthorizationEpoch {
    pub expires_at_ms: u64,
    pub generation_base: u64,
    grant_expires_at_ms: u64,
    monotonic_deadline_ms: f64,
    commitment: [u8; 64],
}

impl AuthorizationEpoch {
    pub fn new(expires_at_ms: u64, commitment: [u8; 64], wall_ms: u64, now_ms: f64) -> Self {
        Self {
            expires_at_ms,
            generation_base: 0,
            grant_expires_at_ms: expires_at_ms,
            monotonic_deadline_ms: now_ms + expires_at_ms.saturating_sub(wall_ms) as f64,
            commitment,
        }
    }

    pub fn expired(&self, wall_ms: u64, now_ms: f64) -> bool {
        wall_ms >= self.expires_at_ms || now_ms >= self.monotonic_deadline_ms
    }

    /// Replaying the same capability acknowledges the original epoch. A newer
    /// capability alone replenishes the allowance; the crypto counter never resets.
    pub fn renew(
        &mut self,
        grant_expires_at_ms: u64,
        delegation_expires_at_ms: u64,
        commitment: [u8; 64],
        counter: u64,
        wall_ms: u64,
        now_ms: f64,
    ) -> bool {
        let expires_at_ms = grant_expires_at_ms.min(delegation_expires_at_ms);
        if wall_ms >= expires_at_ms {
            return false;
        }
        if grant_expires_at_ms == self.grant_expires_at_ms && commitment == self.commitment {
            return !self.expired(wall_ms, now_ms);
        }
        if grant_expires_at_ms <= self.grant_expires_at_ms {
            return false;
        }
        *self = Self::new(expires_at_ms, commitment, wall_ms, now_ms);
        self.grant_expires_at_ms = grant_expires_at_ms;
        self.generation_base = counter;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_and_clock_rollback_cannot_replenish_an_epoch() {
        let mut epoch = AuthorizationEpoch::new(1000, [1; 64], 100, 10.0);
        assert!(epoch.renew(2000, 9000, [2; 64], 7, 900, 810.0));
        assert!(epoch.renew(2000, 9000, [2; 64], 14, 1000, 910.0));
        assert_eq!(epoch.generation_base, 7);
        assert!(!epoch.renew(2000, 9000, [3; 64], 14, 1000, 910.0));
        assert!(!epoch.renew(1000, 9000, [1; 64], 14, 999, 910.0));
        assert!(epoch.expired(2000, 911.0));
        assert!(epoch.expired(500, 1910.0));
        assert!(!epoch.renew(2000, 9000, [2; 64], 14, 500, 1910.0));
        assert_eq!(epoch.generation_base, 7);
        assert!(epoch.renew(3000, 9000, [3; 64], 15, 2100, 2010.0));
        assert_eq!(epoch.generation_base, 15);
    }

    #[test]
    fn a_new_grant_renews_the_allowance_near_certificate_expiry_but_not_its_deadline() {
        let mut epoch = AuthorizationEpoch::new(1000, [1; 64], 100, 0.0);
        assert!(epoch.renew(2000, 1500, [2; 64], 7, 200, 100.0));
        assert!(epoch.renew(3000, 1500, [3; 64], 14, 300, 200.0));
        assert_eq!(epoch.expires_at_ms, 1500);
        assert_eq!(epoch.generation_base, 14);
        assert!(epoch.renew(3000, 1500, [3; 64], 20, 400, 300.0));
        assert_eq!(epoch.generation_base, 14);
        assert!(!epoch.renew(4000, 1500, [4; 64], 20, 1500, 1400.0));
    }
}
