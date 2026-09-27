import { createDestinationBroadcaster } from '../src/services/destinationBroadcast';

const fort = { name: 'Golconda Fort, Hyderabad', latitude: 17.3833, longitude: 78.4011 };
const charminar = { name: 'Charminar, Hyderabad', latitude: 17.3616, longitude: 78.4747 };

/** The error LiveKit raises while this phone has no peer connection. */
const pcClosed = () => new Error('PC manager is closed');

describe('createDestinationBroadcaster', () => {
  it('sends the destination and has nothing left waiting', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const broadcaster = createDestinationBroadcaster(publish);

    await expect(broadcaster.send(fort)).resolves.toBe(true);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(fort);
    expect(broadcaster.hasPending()).toBe(false);
  });

  it('reports false, never throws, when LiveKit says "PC manager is closed"', async () => {
    const publish = jest.fn().mockRejectedValue(pcClosed());
    const broadcaster = createDestinationBroadcaster(publish);

    await expect(broadcaster.send(fort)).resolves.toBe(false);
    expect(broadcaster.hasPending()).toBe(true);
  });

  it('sends the same destination again when asked to retry, and stops waiting once it goes', async () => {
    const publish = jest.fn().mockRejectedValueOnce(pcClosed()).mockResolvedValue(undefined);
    const broadcaster = createDestinationBroadcaster(publish);
    await broadcaster.send(fort);

    await expect(broadcaster.retryPending()).resolves.toBe(true);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(fort);
    expect(broadcaster.hasPending()).toBe(false);
  });

  it('keeps waiting through repeated failures until one finally gets through', async () => {
    const publish = jest
      .fn()
      .mockRejectedValueOnce(pcClosed())
      .mockRejectedValueOnce(pcClosed())
      .mockResolvedValue(undefined);
    const broadcaster = createDestinationBroadcaster(publish);
    await broadcaster.send(fort);

    await expect(broadcaster.retryPending()).resolves.toBe(false);
    expect(broadcaster.hasPending()).toBe(true);
    await expect(broadcaster.retryPending()).resolves.toBe(true);
    expect(broadcaster.hasPending()).toBe(false);
  });

  it('does nothing on retry when there is nothing waiting', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const broadcaster = createDestinationBroadcaster(publish);

    await expect(broadcaster.retryPending()).resolves.toBe(true);
    expect(publish).not.toHaveBeenCalled();

    await broadcaster.send(fort);
    publish.mockClear();
    await expect(broadcaster.retryPending()).resolves.toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it('only ever retries the latest destination, not one it was replaced by', async () => {
    const publish = jest.fn().mockRejectedValueOnce(pcClosed()).mockResolvedValue(undefined);
    const broadcaster = createDestinationBroadcaster(publish);
    await broadcaster.send(fort); // fails
    await broadcaster.send(charminar); // succeeds; replaces the one that never went out

    expect(broadcaster.hasPending()).toBe(false);
    publish.mockClear();
    await broadcaster.retryPending();
    expect(publish).not.toHaveBeenCalled();
  });

  it('a newer destination that fails is the one retried, not the older one', async () => {
    const publish = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(pcClosed());
    const broadcaster = createDestinationBroadcaster(publish);
    await broadcaster.send(fort);
    await broadcaster.send(charminar); // fails

    publish.mockReset();
    publish.mockResolvedValue(undefined);
    await broadcaster.retryPending();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(charminar);
  });

  it('an older send that finishes late does not clear a newer destination still waiting', async () => {
    let finishOlder: () => void = () => {};
    const publish = jest
      .fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => (finishOlder = resolve)))
      .mockRejectedValueOnce(pcClosed());
    const broadcaster = createDestinationBroadcaster(publish);

    const older = broadcaster.send(fort); // still in flight
    await broadcaster.send(charminar); // newer one fails
    finishOlder();
    await older;

    expect(broadcaster.hasPending()).toBe(true);
    publish.mockReset();
    publish.mockResolvedValue(undefined);
    await broadcaster.retryPending();
    expect(publish).toHaveBeenCalledWith(charminar);
  });

  it('a synchronous throw from the publisher is treated like any other failure', async () => {
    const publish = jest.fn(() => {
      throw pcClosed();
    });
    const broadcaster = createDestinationBroadcaster(publish as unknown as () => Promise<void>);

    await expect(broadcaster.send(fort)).resolves.toBe(false);
    expect(broadcaster.hasPending()).toBe(true);
  });
});
