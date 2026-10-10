# RideConnectivityClient M1 integration

`RideConnectivityClient` is the application-facing boundary for the Phase 2 connectivity runtime.
It owns one Nearby session at a time and does not accept authentication tokens. Authentication is
an application-layer precondition.

The concrete mobile factory is `createAppRideConnectivityClient()` in
`mobile/src/services/rideConnectivityService.ts`. The interface and its event types are in
`mobile/src/connectivity/rideConnectivityClient.ts`.

## Lifecycle ownership

Create one client for the active ride flow. The current `RideScreen` still owns Nearby through the
legacy controller, so application integration must replace that ownership rather than start this
client alongside it.

```ts
import { createAppRideConnectivityClient } from '../services/rideConnectivityService';

const connectivity = createAppRideConnectivityClient();

await connectivity.start({
  rideId: activeRide.roomCode,
  riderName: activeRide.riderName,
});
```

Calling `start` again for the same `rideId` is idempotent. Starting a different ride while the
client is active rejects with a `lifecycle_error`. `stop` is idempotent, releases the runtime and
transport subscriptions, and allows a later `start` to create a fresh runtime.

```ts
await connectivity.stop();
```

Do not pass a password, access token, authorization header, or LiveKit token to this API.

## Manual SOS submission

Subscribe to delivery status before submitting so the initial states are observed.

```ts
const stopDeliveryObserver = connectivity.onDeliveryStatus(status => {
  if (status.state === 'failed') {
    // Present a retry choice or failure state at the application layer.
  }
});

const { messageId } = await connectivity.sendMessage({
  rideId: activeRide.roomCode,
  type: 'sos',
  priority: 'critical',
  payload: {
    reason: 'manual',
    latitude: latestLocation.latitude,
    longitude: latestLocation.longitude,
  },
  ttlMs: 30_000,
  maxHops: 4,
  destination: { kind: 'gateway' },
});
```

The returned `messageId` confirms local validation and submission only. It is not a delivery
receipt. Payloads must be non-null JSON values; application services remain responsible for the
semantic shape of each application payload.

## Incoming messages

```ts
const stopMessageObserver = connectivity.onMessage(message => {
  switch (message.type) {
    case 'sos':
      handleIncomingSos(message);
      break;
    case 'hazard':
      handleIncomingHazard(message);
      break;
  }
});
```

Only messages accepted by the existing decoder, ride boundary, TTL validation, and deduplication
are published. A routed message is published only at its final gateway; intermediate forwarders do
not publish it. `originId` is an unauthenticated protocol node id and must not be displayed or used
as a verified account identity.

M1 does not replace the Phase 1 `HazardCoordinator`. Existing RideScreen hazard traffic continues
through that coordinator until a separately approved application migration.

## Peer and transport status

```ts
const stopPeerObserver = connectivity.onPeerStatus(status => {
  renderMeshState(status.state, status.directPeerCount);
});
```

`directPeerCount` is the Nearby connection count. It is not an authenticated rider count and does
not identify individual users.

## Delivery semantics

M1 can emit these ordered facts:

```text
queued -> sending -> transport_accepted -> expired
                  \-> failed
```

- `queued`: the client accepted a valid in-memory submission.
- `sending`: the runtime is attempting the gateway-routed send.
- `transport_accepted`: the underlying targeted send operation resolved. This does not prove that
  the destination processed the message.
- `failed`: no successful transport acceptance was observed. For `send_timeout`, `outcome` is
  `unknown`, because the send may still have occurred.
- `expired`: the TTL elapsed without valid destination acknowledgement evidence while this client
  generation remained active.
- `destination_delivered`: reserved in the type contract, but never emitted in M1 because ACK
  correlation and validation do not exist yet.

Stopping the client clears in-memory expiry tracking. M1 has no retry queue or offline persistence.

## Errors and cleanup

```ts
const stopErrorObserver = connectivity.onError(error => {
  reportConnectivityState(error.code, error.reason);
});

// When leaving the ride:
stopMessageObserver();
stopPeerObserver();
stopDeliveryObserver();
stopErrorObserver();
await connectivity.stop();
```

Error events are sanitized and do not include payloads, endpoint ids, raw native errors, or
credentials. One failing application listener is isolated from other listeners and from the
connectivity runtime.

## Not implemented in M1

- Destination ACK generation, authentication, or correlation
- Automatic retries or route failover
- Durable/offline message persistence
- Local cloud upload when this node is the selected gateway
- Cryptographic peer authentication or message signatures
- Migration of RideScreen or application services to the new lifecycle owner

The recommended next milestone is authenticated ACK correlation followed by a bounded persistent
outbox and retry policy. Those capabilities are required before claiming reliable offline SOS
delivery.
