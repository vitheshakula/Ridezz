# M4 dynamic gateway handoff and route recovery

M4 keeps the existing `PeerTable`, `DirectLinkIdentityMap`, `GatewayState`, advertisement flood,
strictly-decreasing gateway metric, hop limit, and message-ID deduplication model.

## Route attempt policy

For each originated or relayed operation, `RoutedForwarder` recalculates fresh candidates before
every attempt. A definitively unusable route is excluded by a node-local route key and the next
deterministic candidate may be tried. Attempts are bounded to three by default.

Alternative submission is allowed only after evidence that nothing was sent:

- unsupported transport;
- no currently usable endpoint; or
- a rejected transport operation.

A send timeout is ambiguous and is never followed immediately by another route submission. This
prevents duplicate sends when the first transport operation may have completed late. Encoding,
expiry, hop-limit, split-horizon, and decreasing-distance failures also fail closed.

## Freshness and topology changes

Candidates are rebuilt from fresh gateway observations and fresh direct-link mappings. Stale
gateways or links therefore disappear without being selected. Endpoint reassignment invalidates
the old route; a new heartbeat/advertisement establishes the replacement. The retry engine added
in M3 can trigger a later operation after reconnection, at which point route selection starts from
current state rather than a cached route.

The original message ID, creation/expiry times, payload, and target gateway remain unchanged for
all attempts toward the same gateway. Relay hop count is incremented once per transmitted hop, not
once per failed local attempt.

## Safety limits

- No route is attempted twice within one operation.
- At most three candidates are attempted.
- Forwarding still requires a strictly smaller gateway distance and excludes the previous hop.
- Advertisement propagation remains bounded by TTL, hop limit, ingress dedupe, and its existing
  scheduler; M4 adds no new topology flood.
- With two devices, physical multi-hop recovery cannot be demonstrated; deterministic topology
  tests cover the routing state machine.
