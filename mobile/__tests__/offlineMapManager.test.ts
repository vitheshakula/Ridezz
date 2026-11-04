function load() {
  jest.resetModules();

  const packs: any[] = [];
  let nextId = 1;
  const mockOfflineManager = {
    createPack: jest.fn(async (options: any, onProgress: any, _onError: any) => {
      const pack = {
        id: `pack-${nextId++}`,
        metadata: options.metadata,
        bounds: options.bounds,
        status: jest.fn(async () => ({ state: 'active', percentage: 0 })),
        pause: jest.fn(async () => {}),
        resume: jest.fn(async () => {}),
      };
      packs.push(pack);
      onProgress?.(pack, { state: 'active', percentage: 0 });
      return pack;
    }),
    deletePack: jest.fn(async (id: string) => {
      const index = packs.findIndex(p => p.id === id);
      if (index >= 0) {
        packs.splice(index, 1);
      }
    }),
    getPacks: jest.fn(async () => [...packs]),
  };

  jest.doMock('@maplibre/maplibre-react-native', () => ({ OfflineManager: mockOfflineManager }));

  return {
    manager:
      require('../src/services/offlineMapManager') as typeof import('../src/services/offlineMapManager'),
    mockOfflineManager,
  };
}

const BOUNDS = { west: 78.3, south: 17.3, east: 78.5, north: 17.45 };

describe('downloadOfflineRegion', () => {
  it("creates a pack with the bounds in MapLibre's [west, south, east, north] order", async () => {
    const { manager, mockOfflineManager } = load();
    await manager.downloadOfflineRegion({
      name: 'ride-ABC123',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });

    expect(mockOfflineManager.createPack).toHaveBeenCalledWith(
      expect.objectContaining({
        mapStyle: 'https://style.json',
        bounds: [BOUNDS.west, BOUNDS.south, BOUNDS.east, BOUNDS.north],
        metadata: { name: 'ride-ABC123' },
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('applies sensible default zoom levels when none are given', async () => {
    const { manager, mockOfflineManager } = load();
    await manager.downloadOfflineRegion({
      name: 'r',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });
    const options = mockOfflineManager.createPack.mock.calls[0][0];
    expect(options.minZoom).toBe(10);
    expect(options.maxZoom).toBe(16);
  });

  it('honours explicit zoom levels', async () => {
    const { manager, mockOfflineManager } = load();
    await manager.downloadOfflineRegion({
      name: 'r',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
      minZoom: 5,
      maxZoom: 12,
    });
    const options = mockOfflineManager.createPack.mock.calls[0][0];
    expect(options.minZoom).toBe(5);
    expect(options.maxZoom).toBe(12);
  });

  it('forwards progress updates', async () => {
    const { manager } = load();
    const onProgress = jest.fn();
    await manager.downloadOfflineRegion({
      name: 'r',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith({ state: 'active', percentage: 0 });
  });

  it('replaces an existing region of the same name instead of leaving a duplicate behind', async () => {
    const { manager, mockOfflineManager } = load();
    const first = await manager.downloadOfflineRegion({
      name: 'ride-ABC123',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });
    await manager.downloadOfflineRegion({
      name: 'ride-ABC123',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });

    expect(mockOfflineManager.deletePack).toHaveBeenCalledWith(first.id);
    const remaining = (await mockOfflineManager.getPacks()).filter(
      (p: any) => p.metadata.name === 'ride-ABC123',
    );
    expect(remaining).toHaveLength(1);
  });

  it('does not disturb a differently named region', async () => {
    const { manager, mockOfflineManager } = load();
    await manager.downloadOfflineRegion({
      name: 'ride-A',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });
    await manager.downloadOfflineRegion({
      name: 'ride-B',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });

    expect(mockOfflineManager.deletePack).not.toHaveBeenCalled();
    expect(await mockOfflineManager.getPacks()).toHaveLength(2);
  });
});

describe('findRegionByName / getRegionStatus', () => {
  it('finds a region created earlier by its name', async () => {
    const { manager } = load();
    await manager.downloadOfflineRegion({
      name: 'ride-ABC123',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });
    const found = await manager.findRegionByName('ride-ABC123');
    expect(found?.metadata).toEqual({ name: 'ride-ABC123' });
  });

  it('returns undefined for a name that was never downloaded', async () => {
    const { manager } = load();
    expect(await manager.findRegionByName('never-downloaded')).toBeUndefined();
  });

  it('reports status for a known region, and null for an unknown one', async () => {
    const { manager } = load();
    await manager.downloadOfflineRegion({
      name: 'ride-ABC123',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });
    expect(await manager.getRegionStatus('ride-ABC123')).toEqual({
      state: 'active',
      percentage: 0,
    });
    expect(await manager.getRegionStatus('never-downloaded')).toBeNull();
  });
});

describe('pauseRegion / resumeRegion / deleteRegion', () => {
  it('pauses and resumes a known region', async () => {
    const { manager } = load();
    await manager.downloadOfflineRegion({
      name: 'r',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });
    const pack = await manager.findRegionByName('r');

    await manager.pauseRegion('r');
    expect(pack?.pause).toHaveBeenCalledTimes(1);
    await manager.resumeRegion('r');
    expect(pack?.resume).toHaveBeenCalledTimes(1);
  });

  it('is a no-op pausing, resuming or deleting a region that does not exist', async () => {
    const { manager, mockOfflineManager } = load();
    await expect(manager.pauseRegion('ghost')).resolves.toBeUndefined();
    await expect(manager.resumeRegion('ghost')).resolves.toBeUndefined();
    await expect(manager.deleteRegion('ghost')).resolves.toBeUndefined();
    expect(mockOfflineManager.deletePack).not.toHaveBeenCalled();
  });

  it('deletes a known region', async () => {
    const { manager, mockOfflineManager } = load();
    await manager.downloadOfflineRegion({
      name: 'r',
      bounds: BOUNDS,
      mapStyleUrl: 'https://style.json',
    });
    await manager.deleteRegion('r');

    expect(await manager.findRegionByName('r')).toBeUndefined();
    expect(await mockOfflineManager.getPacks()).toHaveLength(0);
  });
});
