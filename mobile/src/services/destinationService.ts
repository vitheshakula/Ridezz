import axios from 'axios';
import { MAPTILER_API_KEY } from '@env';
import type { RideDestination } from '../components/RiderMap';
import { api } from './AuthService';

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
    const feature = response.data?.features?.[0];
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
      name: typeof feature.place_name === 'string' ? feature.place_name : trimmed,
      latitude,
      longitude,
    };
  } catch {
    return null;
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
