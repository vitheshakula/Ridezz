import { OfflineManager, type OfflinePack, type OfflinePackStatus } from '@maplibre/maplibre-react-native';
import type { LngLatBounds } from '@maplibre/maplibre-react-native';

/** A bounding box to pre-download, as named corners rather than MapLibre's positional
 * [west, south, east, north] tuple -- easy to get the order wrong passing that by hand. */
export interface OfflineRegionBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface DownloadOfflineRegionOptions {
  /** A stable name for this ride's region, e.g. derived from the room code or route. Stored in the
   * pack's own metadata and used to find it again -- findRegionByName/deleteRegion/getRegionStatus
   * all key off this, not MapLibre's own auto-generated pack id, so a screen never has to hold onto
   * that id itself between app opens. */
  name: string;
  bounds: OfflineRegionBounds;
  mapStyleUrl: string;
  minZoom?: number;
  maxZoom?: number;
  onProgress?: (status: OfflinePackStatus) => void;
  onError?: (message: string) => void;
}

/** Wide enough to show the whole ride at a glance down to street-level turns, without the tile
 * count (and download size/time) a lower minZoom or higher maxZoom would add. */
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 16;

function toLngLatBounds(bounds: OfflineRegionBounds): LngLatBounds {
  return [bounds.west, bounds.south, bounds.east, bounds.north];
}

/** The first offline pack whose metadata carries this name, if any. */
export async function findRegionByName(name: string): Promise<OfflinePack | undefined> {
  const packs = await OfflineManager.getPacks();
  return packs.find(pack => pack.metadata?.name === name);
}

/**
 * Downloads map tiles for `bounds` so the ride's area is usable with no connectivity. Safe to call
 * again for the same `name` with different bounds (a destination picked, then changed, before the
 * ride starts): the previous pack by that name is deleted first rather than left behind as an
 * orphaned, never-cleaned-up duplicate download.
 *
 * `onProgress`/`onError` fire repeatedly over the course of the download; this resolves (with the
 * pack) once the download has merely been registered, not once it's complete -- check
 * getRegionStatus(name), or rely on onProgress's own state field, to know when it actually
 * finishes.
 */
export async function downloadOfflineRegion(options: DownloadOfflineRegionOptions): Promise<OfflinePack> {
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

/** Download progress/state for a named region, or null if no such region has been downloaded
 * (never started, or already deleted). */
export async function getRegionStatus(name: string): Promise<OfflinePackStatus | null> {
  const pack = await findRegionByName(name);
  return pack ? pack.status() : null;
}

/** Pauses an in-progress download; resumeRegion continues it. A no-op if the region isn't known. */
export async function pauseRegion(name: string): Promise<void> {
  const pack = await findRegionByName(name);
  await pack?.pause();
}

export async function resumeRegion(name: string): Promise<void> {
  const pack = await findRegionByName(name);
  await pack?.resume();
}

/** Deletes a named region's tiles, freeing the space. A no-op if it isn't known. */
export async function deleteRegion(name: string): Promise<void> {
  const pack = await findRegionByName(name);
  if (pack) {
    await OfflineManager.deletePack(pack.id);
  }
}
