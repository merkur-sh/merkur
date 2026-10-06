---
paths:
  - "apps/stun/**"
  - "apps/server/src/services/stun-ticket-service*.ts"
  - "packages/merkur-stun-protocol/**"
---

# STUN tickets

`apps/stun` is the authenticated STUN Binding responder that replaced public STUN with no
fallback list. It is ticketed, and every rejection is silence, because an error response
would be the amplification. The ticket format has two implementations
(`stun-ticket-service.ts` issues, `apps/stun/src/ticket.rs` verifies) pinned to one vector
by both suites, because nothing at runtime detects drift. Gate: `rust:lint`,
`cargo test -p merkur-stun`, and
`bun test apps/server/src/services/stun-ticket-service.test.ts`; NAT traversal changes need
`test:natlab`, the only place the side-channel punch and a v6 pinhole are proven.
