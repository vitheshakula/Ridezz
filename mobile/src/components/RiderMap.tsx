import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, Map, Marker } from '@maplibre/maplibre-react-native';
import { MAPTILER_API_KEY } from '@env';
import {
  classifyFreshness,
  formatDistance,
  formatUpdatedAgo,
  haversineDistanceMeters,
  type RiderLocation,
} from '../utils/riderLocation';

interface RiderMapProps {
  locations: RiderLocation[];
  localIdentity: string;
  statusMessage?: string | null;
}

const FRESHNESS_COLOR: Record<string, string> = {
  live: '#3fb950',
  stale: '#d29922',
  offline: '#6b7280',
};

const MAP_STATUS_TICK_MS = 5000;
const CAMERA_ANIMATION_MS = 400;
const CENTER_ZOOM = 15;
const INITIAL_ZOOM = 13;
const FIT_PADDING = { top: 80, right: 80, bottom: 80, left: 80 };
const MAPTILER_STYLE_URL = `https://api.maptiler.com/maps/streets-v4/style.json?key=${encodeURIComponent(
  MAPTILER_API_KEY || '',
)}`;

type LngLat = [number, number];

function hasValidCoordinate(location: RiderLocation): boolean {
  return (
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function toLngLat(location: Pick<RiderLocation, 'latitude' | 'longitude'>): LngLat {
  return [location.longitude, location.latitude];
}

function getLocationsBounds(locations: RiderLocation[]): [number, number, number, number] {
  const longitudes = locations.map(location => location.longitude);
  const latitudes = locations.map(location => location.latitude);
  return [
    Math.min(...longitudes),
    Math.min(...latitudes),
    Math.max(...longitudes),
    Math.max(...latitudes),
  ];
}

function getBoundsCenter(bounds: [number, number, number, number]): LngLat {
  const [west, south, east, north] = bounds;
  return [(west + east) / 2, (south + north) / 2];
}

function areBoundsTooTight(bounds: [number, number, number, number]): boolean {
  const [west, south, east, north] = bounds;
  return Math.abs(east - west) < 0.0001 && Math.abs(north - south) < 0.0001;
}

export default function RiderMap({ locations, localIdentity, statusMessage }: RiderMapProps) {
  const cameraRef = useRef<ElementRef<typeof Camera>>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const validLocations = useMemo(() => locations.filter(hasValidCoordinate), [locations]);
  const localLocation = validLocations.find(l => l.participantIdentity === localIdentity) ?? null;

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), MAP_STATUS_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  // Center on the first local GPS fix once. After that, manual map panning wins.
  const hasCenteredOnceRef = useRef(false);
  useEffect(() => {
    if (hasCenteredOnceRef.current || !localLocation) {
      return;
    }
    hasCenteredOnceRef.current = true;
    cameraRef.current?.easeTo({
      center: toLngLat(localLocation),
      zoom: CENTER_ZOOM,
      duration: CAMERA_ANIMATION_MS,
    });
  }, [localLocation]);

  const centerOnLocation = useCallback((location: RiderLocation) => {
    cameraRef.current?.easeTo({
      center: toLngLat(location),
      zoom: CENTER_ZOOM,
      duration: CAMERA_ANIMATION_MS,
    });
  }, []);

  const handleFitGroup = useCallback(() => {
    const usableLocations = validLocations.filter(
      location => classifyFreshness(location, nowMs) !== 'offline',
    );

    if (usableLocations.length === 0) {
      return;
    }

    if (usableLocations.length === 1) {
      centerOnLocation(usableLocations[0]);
      return;
    }

    const bounds = getLocationsBounds(usableLocations);
    if (areBoundsTooTight(bounds)) {
      cameraRef.current?.easeTo({
        center: getBoundsCenter(bounds),
        zoom: CENTER_ZOOM,
        duration: CAMERA_ANIMATION_MS,
      });
      return;
    }

    cameraRef.current?.fitBounds(bounds, {
      padding: FIT_PADDING,
      duration: CAMERA_ANIMATION_MS,
    });
  }, [centerOnLocation, nowMs, validLocations]);

  const handleCenterMe = useCallback(() => {
    if (!localLocation) {
      return;
    }
    centerOnLocation(localLocation);
  }, [centerOnLocation, localLocation]);

  return (
    <View style={styles.container}>
      <Map style={styles.map} mapStyle={MAPTILER_STYLE_URL}>
        <Camera
          ref={cameraRef}
          initialViewState={
            localLocation
              ? { center: toLngLat(localLocation), zoom: INITIAL_ZOOM }
              : { zoom: 2 }
          }
        />
        {validLocations.map((location, index) => {
          const isLocal = location.participantIdentity === localIdentity;
          const freshness = classifyFreshness(location, nowMs);
          const distance =
            !isLocal && localLocation
              ? haversineDistanceMeters(localLocation, location)
              : null;

          return (
            <Marker
              key={`${location.participantIdentity || 'rider'}-${index}`}
              id={`${location.participantIdentity || 'rider'}-${index}`}
              lngLat={toLngLat(location)}
              anchor="bottom"
            >
              <RiderMarker
                location={location}
                isLocal={isLocal}
                freshness={freshness}
                distance={distance}
                nowMs={nowMs}
              />
            </Marker>
          );
        })}
      </Map>

      {statusMessage ? (
        <View style={styles.statusOverlay}>
          <Text style={styles.statusOverlayText}>{statusMessage}</Text>
        </View>
      ) : null}

      <View style={styles.controls}>
        <Pressable style={styles.controlButton} onPress={handleFitGroup}>
          <Text style={styles.controlButtonText}>Fit Group</Text>
        </Pressable>
        <Pressable
          style={[styles.controlButton, !localLocation && styles.controlButtonDisabled]}
          onPress={handleCenterMe}
          disabled={!localLocation}
        >
          <Text style={styles.controlButtonText}>Center Me</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface RiderMarkerProps {
  location: RiderLocation;
  isLocal: boolean;
  freshness: 'live' | 'stale' | 'offline';
  distance: number | null;
  nowMs: number;
}

function RiderMarker({ location, isLocal, freshness, distance, nowMs }: RiderMarkerProps) {
  const statusText = freshness === 'offline' ? 'Offline' : 'Online';
  const ageText = formatUpdatedAgo(nowMs - location.timestamp);
  const displayName = location.participantName.trim() || location.participantIdentity || 'Rider';
  const markerColor = isLocal ? '#2f81f7' : FRESHNESS_COLOR[freshness];

  return (
    <View style={[styles.markerWrap, freshness === 'offline' && styles.markerOffline]}>
      <View style={styles.markerCard}>
        <Text style={styles.markerName} numberOfLines={1}>
          {displayName}
          {isLocal ? ' (you)' : ''}
        </Text>
        <Text style={styles.markerDetail}>{statusText}</Text>
        <Text style={styles.markerDetail}>{ageText}</Text>
        {location.accuracy !== undefined ? (
          <Text style={styles.markerDetail}>Accuracy +/-{Math.round(location.accuracy)}m</Text>
        ) : null}
        {distance !== null ? (
          <Text style={styles.markerDetail}>{formatDistance(distance)}</Text>
        ) : null}
      </View>
      <View style={[styles.markerPin, { backgroundColor: markerColor }]}>
        <View style={styles.markerPinCore} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  controls: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  controlButton: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  controlButtonDisabled: {
    opacity: 0.5,
  },
  controlButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  statusOverlay: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  statusOverlayText: {
    color: '#c9d1d9',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  markerWrap: {
    alignItems: 'center',
    maxWidth: 180,
  },
  markerOffline: {
    opacity: 0.55,
  },
  markerCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#d0d7de',
    marginBottom: 4,
    minWidth: 116,
  },
  markerName: {
    color: '#24292f',
    fontWeight: '700',
    fontSize: 13,
    marginBottom: 2,
  },
  markerDetail: {
    fontSize: 11,
    color: '#57606a',
  },
  markerPin: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 3,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerPinCore: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ffffff',
  },
});
