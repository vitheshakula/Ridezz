import axios from 'axios';
import { MAPTILER_API_KEY } from '@env';
import type { RideDestination } from '../components/RiderMap';
import { api } from './AuthService';

/** A MapTiler geocoding feature as a destination, or null when it has no usable point. */
function destinationFromFeature(feature: any, fallbackName: string): RideDestination | null {
  const center = feature?.center;
  if (!Array.isArray(center) || center.length !== 2) {
    return null;
  }
  const [longitude, latitude] = center;
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  return {
    name: typeof feature.place_name === 'string' ? feature.place_name : fallbackName,
    latitude,
    longitude,
  };
}

export async function geocodeDestination(query: string): Promise<RideDestination | null> {
  const trimmed = query.trim();
  if (!trimmed || !MAPTILER_API_KEY) {
    return null;
  }

  try {
    const response = await axios.get(
      `https://api.maptiler.com/geocoding/${encodeURIComponent(trimmed)}.json`,
      { params: { key: MAPTILER_API_KEY, limit: 1 }, timeout: 8000 },
    );
    return destinationFromFeature(response.data?.features?.[0], trimmed);
  } catch {
    return null;
  }
}

export const MIN_SUGGESTION_QUERY_LENGTH = 3;
const MAX_SUGGESTIONS = 5;

/** Type-ahead destination suggestions from the same MapTiler geocoding API, biased toward the
 * phone's area (MapTiler resolves `proximity=ip` from the request). Empty on any failure --
 * suggestions are a convenience, and typing a place and submitting still geocodes as before. */
export async function searchDestinations(query: string): Promise<RideDestination[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_SUGGESTION_QUERY_LENGTH || !MAPTILER_API_KEY) {
    return [];
  }

  try {
    const response = await axios.get(
      `https://api.maptiler.com/geocoding/${encodeURIComponent(trimmed)}.json`,
      {
        params: { key: MAPTILER_API_KEY, limit: MAX_SUGGESTIONS, autocomplete: true, proximity: 'ip' },
        timeout: 8000,
      },
    );
    const features: unknown[] = Array.isArray(response.data?.features) ? response.data.features : [];
    return features
      .map(feature => destinationFromFeature(feature, trimmed))
      .filter((destination): destination is RideDestination => destination !== null);
  } catch {
    return [];
  }
}

export async function updateRoomDestination(
  roomCode: string,
  destination: RideDestination,
  authToken: string,
): Promise<RideDestination> {
  const response = await api.patch(
    `/rooms/${encodeURIComponent(roomCode)}/destination`,
    {
      destinationName: destination.name,
      destinationLat: destination.latitude,
      destinationLng: destination.longitude,
    },
    {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: 8000,
    },
  );

  return {
    name: response.data.destinationName ?? null,
    latitude: response.data.destinationLat,
    longitude: response.data.destinationLng,
  };
}
