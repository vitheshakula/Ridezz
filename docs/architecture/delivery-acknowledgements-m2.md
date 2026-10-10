# M2 delivery acknowledgements and security boundary

M2 adds end-to-end acknowledgement correlation without changing the existing Phase 2 envelope or
claiming that a transport send is destination delivery.

## ACK flow

1. The origin registers the original message ID, ride, origin node, expiry, and selected gateway.
2. Every relay records a short-lived reverse-path breadcrumb keyed by the original message ID.
3. A destination may create a versioned `ack` message only after application acceptance.
4. The ACK follows the recorded endpoint path in reverse. It preserves its own message ID while
   normal hop count and TTL rules remain enforced.
5. The origin checks correlation, destination identity, expiry, replay state, and an injected
   verifier before emitting `destination_delivered`.

Duplicate, unknown, late, wrong-ride, wrong-origin, wrong-destination, and unverifiable ACKs are
rejected. A missing reverse route is a failed return attempt, not delivery evidence.

## Cryptographic boundary and blocker

The repository does not provide a backend-issued ride-membership credential, public verification
key, key rotation/revocation contract, or native established signature implementation. Therefore
the production composition does **not** install an ACK verifier and fails closed: received ACKs
cannot advance delivery to `destination_delivered`.

`DeliveryAcknowledgementVerifier` is the explicit integration boundary. Its production
implementation must verify a backend-authorized, ride-scoped credential and an established
signature primitive such as Ed25519. The stable signing input binds the ride, original message ID,
original origin, destination node, acknowledgement time, key ID, and replay nonce. The public ride
code and self-reported node IDs are never authentication secrets.

Until that backend contract exists, Rideaze must not claim authenticated peers, authenticated
message origins, or trustworthy destination receipts on physical devices.

## Gateway handoff

The public client accepts an optional `handoffToGateway` adapter for a locally cloud-reachable
node. It preserves the original message ID and reports only `transport_accepted` when the adapter
accepts the handoff. Missing, rejected, thrown, or duplicate handoffs fail without claiming cloud
delivery. Backend durable ingest and cloud receipts remain separate blocked contracts.
