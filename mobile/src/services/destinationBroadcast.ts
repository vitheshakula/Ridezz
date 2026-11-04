import type { RideDestination } from '../components/RiderMap';

export interface DestinationBroadcaster {
  send(destination: RideDestination): Promise<boolean>;
  retryPending(): Promise<boolean>;
  hasPending(): boolean;
}

export function createDestinationBroadcaster(
  publish: (destination: RideDestination) => Promise<void>,
): DestinationBroadcaster {
  let pending: RideDestination | null = null;

  async function send(destination: RideDestination): Promise<boolean> {
    pending = destination;
    try {
      await publish(destination);
    } catch {
      return false;
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
