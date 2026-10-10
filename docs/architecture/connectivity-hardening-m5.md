# M5 connectivity hardening and integration contract

## Public application API

Application services use only `RideConnectivityClient`:

- `start({ rideId, riderName })`
- `stop()`
- `sendMessage(input)`
- `onMessage(listener)`
- `onPeerStatus(listener)`
- `onDeliveryStatus(listener)`
- `onError(listener)`

`start`/`stop` are serialized and idempotent. A second active ride is rejected. Listener failures
are isolated. The client owns one Nearby session; it must replace, not run beside, RideScreen's
legacy owner when Jaswant migrates the application flow.

Mahesh's sensor services should publish semantic application events to Jaswant's services, which
then call `sendMessage`. Sensor code must not import `NearbyTransport`, routing tables, or native
endpoint APIs.

## Delivery lifecycle

The observable lifecycle is:

```text
queued -> sending -> transport_accepted -> destination_delivered
                    |                    \-> retry / expiry while awaiting verified ACK
                    \-> retry_scheduled -> sending
                                         \-> failed (retry exhausted)
```

`transport_accepted` is never destination delivery. `destination_delivered` requires a correlated,
non-expired, non-replayed ACK accepted by `DeliveryAcknowledgementVerifier`. The Android outbox is
encrypted at rest and survives process restart. Route retry is bounded and does not fan out after
an ambiguous timeout.

## Sanitized observability

Runtime diagnostics cover discovery/heartbeats, link mapping, gateway observations, route changes,
forwarding, ACK return, and failures. Client diagnostics cover peer state, submission/delivery
state, retry exhaustion, and structured errors. They include only state names, counts, and an
eight-character prefix of random protocol IDs. Payloads, precise locations, credentials, tokens,
keys, signatures, endpoint IDs, and raw native errors are excluded.

## Security assumptions and blocker

The ACK verifier is fail-closed in the production composition because the backend currently has no
ride-membership certificate/public-key issuance contract. The implementation therefore does not
claim authenticated peers, message origins, or delivery receipts in the shipping app. Completing
that contract requires backend work outside this connectivity-only task: membership authorization,
public verification keys, rotation/revocation, and an established mobile signature provider.

Local gateway handoff is also an adapter boundary. Handoff acceptance is reported as transport
acceptance only; durable cloud ingest needs an idempotent backend receipt before it can become
delivery evidence.

## Compatibility

- Phase 2 message envelopes, Nearby/LiveKit transports, HazardCoordinator, and RideScreen behavior
  remain intact.
- RideScreen is deliberately not migrated in this branch.
- Existing unsigned Phase 2 application messages continue to decode; unsigned ACKs cannot advance
  the reliable-delivery state.
- Android receives Keystore-backed persistence. iOS fails closed because no secure store is
  implemented here.

## Android physical validation required

Before application integration is accepted, build and install a fresh APK containing commits M1
through M5, then validate on at least three devices:

1. permissions denied, Bluetooth disabled, and Nearby unavailable;
2. rapid start/stop and repeated ride joins;
3. background/foreground behavior and process restart;
4. direct and two-hop routing, ACK return, gateway loss, and alternate recovery;
5. offline persistence/retry and expiry after restart;
6. storage-key invalidation/corruption recovery;
7. no duplicate application side effects during ACK loss or ambiguous transport timeout;
8. sanitized Logcat output with no payload, token, key, or signature disclosure.

Two devices cannot physically verify multi-hop routing or gateway propagation through an
intermediate relay.
