# M7-A — Connectivity test probe

## Purpose

Until now no application component called `RideConnectivityClient.sendMessage()`. The encrypted
outbox, gateway routing, targeted Nearby sends, relays, dedup, retries and expiry were unit-tested
but could not be exercised on physical phones. Hazards, crash alerts, hard braking and mesh sync
still use the legacy Nearby broadcast path and are **unchanged**.

The probe is a developer-only trigger that submits **one** low-priority `ride_state` message
through the real, application-wide client, so a device test runs the production modules end to
end. It is a test instrument, not a feature.

**The probe does not prove authenticated destination delivery.** No ACK signer or verifier exists
yet, so `destination_delivered` cannot occur. What the probe can show is: the message was queued,
which next hop was chosen, that a hop accepted it, that relays forwarded it, and that a gateway
received it.

## Components changed

| File | Change |
|---|---|
| `mobile/src/connectivity/connectivityTestProbe.ts` | New. Flag, gating, rate limits, submission, sanitized diagnostics. Imports only the client contract. |
| `mobile/src/services/rideConnectivityService.ts` | `getAppConnectivityTestProbe()`, `sendAppConnectivityTestProbe()`, arms/disarms the probe on protocol-mode ride sessions, debug dev-menu item. No effect when disabled. |
| `mobile/src/connectivity/reliableDeliveryEngine.ts` | Additive: `retry_scheduled` / `retry_exhausted` events carry `lastAttemptReason`. |
| `mobile/src/connectivity/rideConnectivityClient.ts` | Additive: `retry_scheduled` and `failed: retry_exhausted` statuses carry a sanitized `lastAttempt` (`awaiting_acknowledgement`, `routing_unavailable`, `transport_unavailable`, `send_timeout`, ...). Retry limits, ACK handling and terminal states are unchanged. |
| `mobile/src/connectivity/rideConnectivityLifecycle.ts` | Routed diagnostics now include the envelope hop count. |
| `mobile/__tests__/connectivityTestProbe.test.ts` | New tests. |

Not changed: native Kotlin, RideScreen, hazards, crash detection, braking, mesh sync, LiveKit,
backend, `.env`, `FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST`, ACK verification, wire format.

## Feature flag and gating

The probe runs only when **both** are true:

1. `ENABLE_CONNECTIVITY_TEST_PROBE` (in `connectivityTestProbe.ts`) is `true`. Committed value:
   `false`, enforced by a unit test.
2. The build is a development build (`__DEV__`). A release APK can never run or show the probe,
   even with the flag accidentally committed as `true`.

When disabled, nothing is created, subscribed or registered.

### Enable locally (never commit)

1. In your working copy, set `export const ENABLE_CONNECTIVITY_TEST_PROBE = true;`.
2. Build and install a **debug** APK on every test phone (`cd mobile/android && gradlew.bat
   installDebug`, or `npx react-native run-android`). A debug APK loads JavaScript from Metro:
   run `npx react-native start` on the laptop and `adb -s <serial> reverse tcp:8081 tcp:8081` for
   each USB-connected phone.
3. Open the React Native dev menu (shake, or `adb -s <serial> shell input keyevent 82`) and choose
   **Rideaze: send connectivity test probe**.

### Disable

Set the flag back to `false` (or `git checkout -- mobile/src/connectivity/connectivityTestProbe.ts`)
and confirm `git diff` is empty for that file before any commit. The unit test fails if it is left
`true`.

## Message

| Field | Value |
|---|---|
| type | `ride_state` (gateway-routable, non-emergency, no app listener acts on it) |
| priority | `low` |
| payload | `{ "probe": "rideaze-connectivity-probe-v1", "seq": <1..10> }` (no rider, location or account data) |
| ttlMs | `60000` |
| maxHops | `4` |
| destination | best currently known gateway |

The message id, ride id, origin node id and timestamps are produced by the client exactly as for
any application message (secure id generator, never `Math.random`).

## Limits

- One press submits at most one message.
- At most one probe per 5 s (a press while a submission is in flight is also rate limited).
- At most 10 probes per ride session; counters reset when the ride session ends.
- No timers of its own; retries are the outbox's (max 5 attempts, 1/2/4/8 s backoff).

## Protocol path exercised

```
dev menu → sendAppConnectivityTestProbe → probe.send
  → RideConnectivityClient.sendMessage (validation, wire-size check, secure id)
  → ReliableDeliveryEngine.submit → PersistentOutbox (AES-GCM, Android Keystore)
  → attempt → RideConnectivityRuntime.sendToGateway
  → RoutedForwarder.sendOriginated → gateway route selection (fresh advert + fresh direct link)
  → NearbyTransport.sendTo → NearbyMeshModule.sendPayloadTo (one endpoint, never broadcast)
relay:   onPayloadReceivedFrom → ingress (dedup) → RoutedForwarder.forwardAccepted
         (strictly decreasing distance) → sendTo next hop
gateway: ingress → forwarder "gateway_reached" → client.onMessage → probe receipt log
```

## Debug gateway

Exactly one phone acts as the test gateway: dev menu **Rideaze: toggle test cloud gateway**
(debug builds only, resets on restart). Never set `FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST` for this
procedure.

## Diagnostics

Shown in Settings → Diagnostics (100-entry in-memory log, "Copy log") and, in debug builds, in
`adb logcat -s ReactNativeJS` (prefixed `[RideConnectivity]`; logcat keeps the complete record).
Native lines: `adb logcat -s NearbyMesh`.

Sender:

```
probe #3 submitted | id=abcd1234
probe abcd1234 | queued
probe abcd1234 | transport_accepted (one hop accepted; not delivery)
probe abcd1234 | retry_scheduled in 1s | last=awaiting_acknowledgement
probe abcd1234 | retry_exhausted | delivery_unconfirmed | last=awaiting_acknowledgement
```

No gateway: `retry_scheduled ... | last=routing_unavailable`, ending in
`retry_exhausted | delivery_unconfirmed | last=routing_unavailable`.

Relay: `routed abcd1234 -> 9f8e7d6c (hop 1)` (existing connectivity diagnostics; hop = relays
passed, including this one).

Gateway: `gateway reached for message abcd1234 (hop 1)` and
`probe abcd1234 | gateway_received | from 1a2b3c4d seq=3`. A non-gateway node that somehow
receives a probe logs `received_unrouted`, never `gateway_received`.

Interpretation: `transport_accepted` = one Nearby hop accepted the bytes. `gateway_received` = the
gateway's protocol stack accepted the message. Neither is verified destination delivery.

**Expected ending for a successful run is `retry_exhausted | delivery_unconfirmed`.** Without an
ACK the outbox resends the same message id up to 5 times; the gateway's dedup drops the copies and
logs receipt once.

## Expected failure statuses

| Line | Meaning |
|---|---|
| `probe not sent: no active protocol session` | No ride, or Nearby is in Phase 1-only fallback |
| `probe not sent: rate limited (1 per 5 s)` | Pressed too soon |
| `probe not sent: session limit (10) reached` | Leave and rejoin the ride to reset |
| `submission_failed \| <code>` | Client refused (e.g. outbox full or unavailable) |
| `last=routing_unavailable` | No fresh gateway advertisement + direct link |
| `last=transport_unavailable` | Nearby rejected the targeted send (endpoint gone) |
| `last=send_timeout` | Send did not settle within 2 s (outcome unknown) |
| `expired \| delivery_unconfirmed` | TTL (60 s) elapsed |

## Two-device procedure

1. Both phones: probe-enabled debug APK, Bluetooth on, permissions granted, same ride code.
2. Phone B: toggle test cloud gateway.
3. Wait for, on A: `peer xxxxxxxx on nearby (new_peer)`, `link learned -> <B>`,
   `gateway <B> seen via <B>, hop 0`, `gateway route: <B> via <B> ..., distance 1`.
4. On A: send one probe. Record the id prefix.
5. A: `submitted`, `queued`, `transport_accepted`. B: `gateway reached for message <id> (hop 0)`
   and `probe <id> | gateway_received`. Prefixes must match.
6. Confirm no `destination_delivered` anywhere.

## Three-device procedure (A ↔ B ↔ C)

A and C must have **no** direct Nearby connection. P2P_CLUSTER connects every phone in radio range,
so this requires physical separation (A and C out of range of each other, B between them) and must
be confirmed, not assumed: A's peer list must show only B, and C's only B.

1. C: test cloud gateway.
2. B logs `gateway <C> seen via <C>, hop 0` and `advertisement relayed (hop 1)`.
3. A logs `gateway <C> seen via <B>, hop 1` and `gateway route: <C> via <B> ..., distance 2`.
4. A sends a probe. B logs `routed <id> -> <C> (hop 1)`. C logs `gateway reached for message <id>
   (hop 1)` and `gateway_received`.

The test passes only with B's `routed` line for the same id prefix; C reporting hop 1 is the
evidence of one intermediate forwarder.

## Security limitations

- Node ids, heartbeats and gateway advertisements are unauthenticated; a rogue device in range that
  knows the ride code could impersonate a gateway or relay.
- The room code is advertised in clear in the Nearby endpoint name.
- Native `NearbyMesh` debug logging prints full payloads (the probe payload contains nothing
  sensitive, but other traffic does).
- The probe is unavailable in release builds by construction.

## Known blockers and limitations

| # | Issue | Blocks probe? | Effect on results | Milestone |
|---|---|---|---|---|
| 1 | No production gateway | No (debug toggle) | Gateway is simulated per device | Cloud gateway milestone |
| 2 | No authenticated ACK signer/verifier | No | `destination_delivered` unreachable; every probe ends `retry_exhausted` | ACK milestone |
| 3 | Earlier physical heartbeat-validation failures | Unknown until Test B | If links never form, routing is `routing_unavailable`; no timestamp validation was weakened | Isolate in Test B |
| 4 | Retry exhaustion after an accepted hop reads as failure | No | Now labelled `delivery_unconfirmed` with `last=awaiting_acknowledgement` | ACK milestone |
| 5 | Relay dedup drops origin retries after a relay's own forward failed | No | Retries cannot recover through the same relay; multi-hop recovery tests need an alternate relay | Store-and-forward / per-hop retry |
| 6 | Native stale endpoint handling (dial set not cleared on endpoint lost; one-sided dialing) | Possibly | Phones may fail to connect; check `NearbyMesh` logcat | Native hardening |
| 7 | Shared broadcast queue has no completion timeout | No (probe uses targeted send) | A stuck broadcast stops heartbeats/adverts, so routes go stale | Transport hardening |
| 8 | Node identity per session (reused only while the outbox holds a message for that ride) | No | Rejoining yields a new node id; peers relearn links | Identity milestone |
| 9 | Native plaintext payload logging | No | Do not share raw logcat from real rides | Native hardening |

## Rollback

Revert the M7-A commit. Data-safe: no wire format, storage format or persisted schema changed; the
added status fields are optional and additive.
