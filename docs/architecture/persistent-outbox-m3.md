# M3 persistent outbox and retry engine

M3 introduces a transport-independent `ReliableDeliveryEngine` above the Phase 2 runtime and a
bounded `PersistentOutbox`.

## Semantics

- Messages retain their original protocol ID and encoded envelope across attempts.
- Due work is ordered by priority, next-attempt time, creation time, then ID.
- Retry attempts are bounded and use exponential backoff with bounded jitter.
- Transport acceptance is treated as an attempt result, not destination delivery. Only verified
  destination evidence removes a message as delivered.
- Expired messages are removed without another attempt.
- Duplicate enqueue, capacity overflow, malformed state, retry exhaustion, and storage failures
  remain distinct outcomes.
- Only one pump runs at a time; repeated connectivity notifications coalesce rather than creating
  concurrent duplicate submissions.

The engine accepts an attempt callback, so route selection and transport policy remain in the
existing runtime rather than being duplicated in persistence code.

## Android persistence protection

`RideazeSecureOutbox` stores one serialized queue value in app-private preferences after AES-256
GCM encryption. The non-exported key is generated and retained by Android Keystore. A fresh random
GCM IV is used for every write. Authentication tokens and backend credentials are never queued.
The JavaScript adapter does not fall back to plaintext AsyncStorage.

The encrypted store is Android-specific. iOS has no implementation in this repository and must
remain unavailable rather than silently weakening at-rest protection.

## Integration boundary

The engine is intentionally independent of `RideScreen`, application services, and sensors. M5
composition must connect it to `RideConnectivityClient`, route availability, verified ACKs, and
sanitized diagnostics. Until that composition is enabled, existing RideScreen behavior remains
unchanged.
