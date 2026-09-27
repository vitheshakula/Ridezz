import type { RideDestination } from '../components/RiderMap';

export interface DestinationBroadcaster {
  /** Tries to tell the riders in the room about `destination`. Resolves true once it was sent, or
   * false if it could not be (it is then kept, and `retryPending` sends it). Never rejects. */
  send(destination: RideDestination): Promise<boolean>;
  /** Sends the destination that has not gone out yet, if any. Resolves true when nothing is left
   * waiting. Never rejects. */
  retryPending(): Promise<boolean>;
  hasPending(): boolean;
}

/**
 * Broadcasts a changed ride destination to the other riders without letting a broadcast problem
 * undo the change.
 *
 * Changing the destination has two steps: saving it on the server -- the change itself; riders who
 * join later get it from there -- and telling the riders already in the room over LiveKit. The
 * second can fail for reasons that have nothing to do with the first: while this phone is
 * reconnecting, LiveKit has no peer connection and refuses with "PC manager is closed". That must
 * not turn a saved destination into an error, so failures are held here and sent when asked again
 * (RideScreen asks whenever the room reconnects).
 *
 * Only the latest destination matters: a newer one replaces an older one that never went out, and
 * an older send that finishes late never clears a newer one still waiting.
 */
export function createDestinationBroadcaster(
  publish: (destination: RideDestination) => Promise<void>,
): DestinationBroadcaster {
  let pending: RideDestination | null = null;

  async function send(destination: RideDestination): Promise<boolean> {
    pending = destination;
    try {
      await publish(destination);
    } catch {
      return false; // stays pending
    }
    if (pending === destination) {
      pending = null;
    }
    return true;
  }

  return {
    send,
    retryPending: () => (pending ? send(pending) : Promise.resolve(true)),
    hasPending: () => pending !== null,
  };
}
