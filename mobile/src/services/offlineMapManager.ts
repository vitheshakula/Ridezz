import {
  OfflineManager,
  type OfflinePack,
  type OfflinePackStatus,
} from '@maplibre/maplibre-react-native';
import type { LngLatBounds } from '@maplibre/maplibre-react-native';

export interface OfflineRegionBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface DownloadOfflineRegionOptions {
  name: string;
  bounds: OfflineRegionBounds;
  mapStyleUrl: string;
  minZoom?: number;
  maxZoom?: number;
  onProgress?: (status: OfflinePackStatus) => void;
  onError?: (message: string) => void;
}

const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 16;

function toLngLatBounds(bounds: OfflineRegionBounds): LngLatBounds {
  return [bounds.west, bounds.south, bounds.east, bounds.north];
}

export async function findRegionByName(name: string): Promise<OfflinePack | undefined> {
  const packs = await OfflineManager.getPacks();
  return packs.find(pack => pack.metadata?.name === name);
}

export async function downloadOfflineRegion(
  options: DownloadOfflineRegionOptions,
): Promise<OfflinePack> {
  const {
    name,
    bounds,
    mapStyleUrl,
    minZoom = DEFAULT_MIN_ZOOM,
    maxZoom = DEFAULT_MAX_ZOOM,
    onProgress,
    onError,
  } = options;

  const existing = await findRegionByName(name);
  if (existing) {
    await OfflineManager.deletePack(existing.id);
  }

  return OfflineManager.createPack(
    { mapStyle: mapStyleUrl, bounds: toLngLatBounds(bounds), minZoom, maxZoom, metadata: { name } },
    (_pack, status) => onProgress?.(status),
    (_pack, error) => onError?.(error.message),
  );
}

export async function getRegionStatus(name: string): Promise<OfflinePackStatus | null> {
  const pack = await findRegionByName(name);
  return pack ? pack.status() : null;
}

export async function pauseRegion(name: string): Promise<void> {
  const pack = await findRegionByName(name);
  await pack?.pause();
}

export async function resumeRegion(name: string): Promise<void> {
  const pack = await findRegionByName(name);
  await pack?.resume();
}

export async function deleteRegion(name: string): Promise<void> {
  const pack = await findRegionByName(name);
  if (pack) {
    await OfflineManager.deletePack(pack.id);
  }
}
