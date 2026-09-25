import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, Marker } from '@maplibre/maplibre-react-native';
import { MAPTILER_API_KEY } from '@env';
import {
  classifyFreshness,
  computeCentroid,
  formatDistance,
  formatSpeed,
  formatUpdatedAgo,
  haversineDistanceMeters,
  isFallingBehind,
  type RiderLocation,
} from '../utils/riderLocation';
import { fetchRoadRouteDetailed, formatDuration, type RoadRoute } from '../services/routingService';
import { color as uiColor, radius, spacing, type } from '../theme';

export interface RideDestination {
  name: string | null;
  latitude: number;
  longitude: number;
}

interface RiderMapProps {
  locations: RiderLocation[];
  localIdentity: string;
  statusMessage?: string | null;
  destination?: RideDestination | null;
}

/** Deterministic per-rider marker palette, distinct from the local rider's blue
 * and from each other -- chosen for contrast against the light marker card and
 * against a typical street map background. Freshness is still conveyed (offline
 * riders are dimmed via markerOffline), just not by recoloring the pin. */
const RIDER_COLOR_PALETTE: string[] = [
  '#f97316', // orange
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ef4444', // red
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f43f5e', // rose
  '#8b5cf6', // violet
];

/** Stable hash of a participant identity -> a palette index, so a given rider
 * keeps the same color for the whole ride (and across re-renders) without any
 * server-assigned color state. */
function colorForRider(identity: string): string {
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) % 2147483647;
  }
  return RIDER_COLOR_PALETTE[hash % RIDER_COLOR_PALETTE.length];
}

/** The local rider keeps a fixed, reserved color (never handed out by colorForRider)
 * so "which one is me" never depends on remembering a hash. */
const LOCAL_RIDER_COLOR = '#2f81f7';

const MAP_STATUS_TICK_MS = 5000;
const CAMERA_ANIMATION_MS = 400;
const CENTER_ZOOM = 15;
const INITIAL_ZOOM = 13;
const ROUTE_RETRY_MS = 10_000;
const FIT_PADDING = { top: 80, right: 80, bottom: 80, left: 80 };
// Dark variant so the map reads as part of the app's black UI instead of a bright
// rectangle dropped into it -- confirmed this style exists on the same MapTiler
// account/key as the light one (streets-v4-dark, verified via a direct request).
const MAPTILER_STYLE_URL = `https://api.maptiler.com/maps/streets-v4-dark/style.json?key=${encodeURIComponent(
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

function getPointsBounds(points: LngLat[]): [number, number, number, number] {
  const longitudes = points.map(p => p[0]);
  const latitudes = points.map(p => p[1]);
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

export default function RiderMap({ locations, localIdentity, statusMessage, destination }: RiderMapProps) {
  const cameraRef = useRef<ElementRef<typeof Camera>>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const validLocations = useMemo(() => locations.filter(hasValidCoordinate), [locations]);
  const localLocation = validLocations.find(l => l.participantIdentity === localIdentity) ?? null;
  const destinationLngLat: LngLat | null = useMemo(
    () => (destination ? [destination.longitude, destination.latitude] : null),
    [destination],
  );

  // "Falling behind" is judged against the live/stale group, not riders who've
  // dropped off the map entirely -- an offline rider's stale last-known position
  // shouldn't drag the centroid toward them or get flagged itself.
  const activeLocations = useMemo(
    () => validLocations.filter(location => classifyFreshness(location, nowMs) !== 'offline'),
    [validLocations, nowMs],
  );
  const groupCentroid = useMemo(() => computeCentroid(activeLocations), [activeLocations]);

  // Straight-line ("as the crow flies") guide from the local rider to the destination.
  // Always computed as the fallback: if the real road route below hasn't loaded yet, or
  // its fetch fails, this is what renders instead of nothing.
  const straightLineGeoJSON = useMemo(() => {
    if (!localLocation || !destinationLngLat) {
      return null;
    }
    const meters = haversineDistanceMeters(localLocation, {
      latitude: destinationLngLat[1],
      longitude: destinationLngLat[0],
    });
    const label =
      meters < 1000 ? `${Math.round(meters)} m direct` : `${(meters / 1000).toFixed(1)} km direct`;
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [toLngLat(localLocation), destinationLngLat],
      },
      properties: { label },
    };
  }, [localLocation, destinationLngLat]);

  // Real road-following route via OSRM's free public demo server (no API key -- MapTiler's
  // own Directions API is beta/gated, see routingService.ts). Fetched once per destination,
  // then re-fetched only after the rider has actually moved a meaningful distance from where
  // the current route was fetched -- not on every 15m GPS tick, since this is a shared public
  // server with no uptime guarantee and refetching that often would be both wasteful and rude.
  const [roadRoute, setRoadRoute] = useState<RoadRoute | null>(null);
  const [routeStatus, setRouteStatus] = useState<'idle' | 'loading' | 'road' | 'fallback'>('idle');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeRetry, setRouteRetry] = useState(0);
  const lastSuccessfulRouteRef = useRef<{ from: LngLat; destination: LngLat } | null>(null);
  const REROUTE_THRESHOLD_METERS = 300;

  useEffect(() => {
    if (!localLocation || !destinationLngLat) {
      setRoadRoute(null);
      setRouteStatus('idle');
      setRouteError(null);
      lastSuccessfulRouteRef.current = null;
      return;
    }

    const last = lastSuccessfulRouteRef.current;
    const destinationChanged =
      !last || last.destination[0] !== destinationLngLat[0] || last.destination[1] !== destinationLngLat[1];
    const movedFar =
      !last ||
      haversineDistanceMeters(
        { latitude: last.from[1], longitude: last.from[0] },
        localLocation,
      ) > REROUTE_THRESHOLD_METERS;

    if (!destinationChanged && !movedFar) {
      return;
    }

    let cancelled = false;
    const currentFrom = toLngLat(localLocation);
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setRouteStatus('loading');
    setRouteError(null);

    fetchRoadRouteDetailed(localLocation, {
      latitude: destinationLngLat[1],
      longitude: destinationLngLat[0],
    }).then(result => {
        if (!cancelled) {
          if (result.ok) {
            setRoadRoute(result.route);
            setRouteStatus('road');
            lastSuccessfulRouteRef.current = {
              from: currentFrom,
              destination: destinationLngLat,
            };
          } else {
            console.warn(`Route unavailable: ${result.reason}`);
            setRoadRoute(null);
            setRouteStatus('fallback');
            setRouteError(result.reason);
            retryTimer = setTimeout(() => setRouteRetry(value => value + 1), ROUTE_RETRY_MS);
          }
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [localLocation, destinationLngLat, routeRetry]);

  const roadRouteGeoJSON = useMemo(() => {
    if (!roadRoute) {
      return null;
    }
    const label = `${(roadRoute.distanceMeters / 1000).toFixed(1)} km · ${formatDuration(roadRoute.durationSeconds)}`;
    return {
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: roadRoute.coordinates },
      properties: { label },
    };
  }, [roadRoute]);

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

    // The destination (if set) always joins the group view -- "Fit Group" should mean
    // "everyone plus where we're headed", not just the riders.
    const points: LngLat[] = usableLocations.map(toLngLat);
    if (destinationLngLat) {
      points.push(destinationLngLat);
    }

    if (points.length === 0) {
      return;
    }

    if (points.length === 1) {
      cameraRef.current?.easeTo({
        center: points[0],
        zoom: CENTER_ZOOM,
        duration: CAMERA_ANIMATION_MS,
      });
      return;
    }

    const bounds = getPointsBounds(points);
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
  }, [destinationLngLat, nowMs, validLocations]);

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
        {roadRouteGeoJSON ? (
          // Real road-following route (OSRM). Solid + blue, the way an actual route is
          // conventionally drawn -- visually distinct from the dashed "direct" fallback
          // below, so a rider can tell at a glance which one they're looking at.
          // `key` (not just `id`) is required here: MapLibre's GeoJSONSource throws if its
          // `id` prop changes after mount, and without a distinct `key` React reconciles
          // this ternary's two branches as updates to the same instance rather than an
          // unmount/remount -- confirmed on-device (`Render Error: \`id\` cannot be changed`)
          // the moment the OSRM fetch resolved and this branch swapped in.
          <GeoJSONSource key="roadRoute" id="roadRouteSource" data={roadRouteGeoJSON}>
            <Layer
              id="roadRouteLine"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': '#3b82f6', 'line-width': 4, 'line-opacity': 0.85 }}
            />
            <Layer
              id="roadRouteLabel"
              type="symbol"
              layout={{
                'symbol-placement': 'line-center',
                'text-field': ['get', 'label'],
                'text-size': 12,
                'text-offset': [0, -1.2],
              }}
              paint={{ 'text-color': '#e5e7eb', 'text-halo-color': '#111827', 'text-halo-width': 1.5 }}
            />
          </GeoJSONSource>
        ) : straightLineGeoJSON ? (
          // Fallback while the real route hasn't loaded yet (or OSRM's public demo server
          // is unavailable) -- deliberately dashed and gray, and labeled "direct" rather than
          // with a turn-by-turn distance, so it never reads as an actual route.
          <GeoJSONSource key="straightLine" id="straightLineSource" data={straightLineGeoJSON}>
            <Layer
              id="straightLine"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': '#f59e0b',
                'line-width': 4,
                'line-dasharray': [2, 2],
                'line-opacity': 0.8,
              }}
            />
            <Layer
              id="straightLineLabel"
              type="symbol"
              layout={{
                'symbol-placement': 'line-center',
                'text-field': ['get', 'label'],
                'text-size': 12,
                'text-offset': [0, -1],
              }}
              paint={{
                'text-color': '#e5e7eb',
                'text-halo-color': '#111827',
                'text-halo-width': 1.5,
              }}
            />
          </GeoJSONSource>
        ) : null}

        {validLocations.map((location, index) => {
          const isLocal = location.participantIdentity === localIdentity;
          const freshness = classifyFreshness(location, nowMs);
          const distance =
            !isLocal && localLocation
              ? haversineDistanceMeters(localLocation, location)
              : null;
          const distanceToDestination = destination
            ? haversineDistanceMeters(location, destination)
            : null;
          const fallingBehind =
            freshness !== 'offline' && isFallingBehind(location, groupCentroid);

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
                distanceToDestination={distanceToDestination}
                fallingBehind={fallingBehind}
                nowMs={nowMs}
                color={isLocal ? LOCAL_RIDER_COLOR : colorForRider(location.participantIdentity)}
              />
            </Marker>
          );
        })}

        {destinationLngLat ? (
          <Marker id="destination" lngLat={destinationLngLat} anchor="bottom">
            <DestinationMarker name={destination?.name ?? null} />
          </Marker>
        ) : null}
      </Map>

      {statusMessage ? (
        <View style={styles.statusOverlay}>
          <Text style={styles.statusOverlayText}>{statusMessage}</Text>
        </View>
      ) : null}

      {destination && localLocation ? (
        <View style={styles.routeStatusOverlay}>
          <Text style={styles.routeStatusText} numberOfLines={2}>
            {routeStatus === 'loading'
              ? 'Finding road route...'
              : routeStatus === 'road' && roadRoute
                ? `${(roadRoute.distanceMeters / 1000).toFixed(1)} km · ${formatDuration(roadRoute.durationSeconds)}`
                : `Direct-line fallback${routeError ? ` · ${routeError}` : ''}`}
          </Text>
          {routeStatus === 'fallback' ? (
            <Pressable onPress={() => setRouteRetry(value => value + 1)} hitSlop={10}>
              <Text style={styles.routeRetryText}>Retry</Text>
            </Pressable>
          ) : null}
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
  distanceToDestination: number | null;
  fallingBehind: boolean;
  nowMs: number;
  color: string;
}

/** Below this, a reported heading is more likely GPS/compass jitter on a
 * stopped bike than a real direction of travel -- the arrow only appears
 * once the rider is genuinely moving. */
const MIN_HEADING_SPEED_MPS = 0.5;

function RiderMarker({
  location,
  isLocal,
  freshness,
  distance,
  distanceToDestination,
  fallingBehind,
  nowMs,
  color,
}: RiderMarkerProps) {
  const statusText = freshness === 'offline' ? 'Offline' : 'Online';
  const ageText = formatUpdatedAgo(nowMs - location.timestamp);
  const displayName = location.participantName.trim() || location.participantIdentity || 'Rider';
  const showHeading =
    location.heading !== undefined &&
    location.speed !== undefined &&
    location.speed >= MIN_HEADING_SPEED_MPS &&
    freshness !== 'offline';

  return (
    <View style={[styles.markerWrap, freshness === 'offline' && styles.markerOffline]}>
      <View style={styles.markerCard}>
        <Text style={styles.markerName} numberOfLines={1}>
          {displayName}
          {isLocal ? ' (you)' : ''}
        </Text>
        <View style={styles.markerTitleRow}>
          <Text style={styles.markerDetail}>{statusText}</Text>
          {fallingBehind ? <Text style={styles.fallingBehindBadge}>Falling behind</Text> : null}
        </View>
        <Text style={styles.markerDetail}>{ageText}</Text>
        {location.speed !== undefined ? (
          <Text style={styles.markerDetail}>{formatSpeed(location.speed)}</Text>
        ) : null}
        {location.accuracy !== undefined ? (
          <Text style={styles.markerDetail}>Accuracy +/-{Math.round(location.accuracy)}m</Text>
        ) : null}
        {distance !== null ? (
          <Text style={styles.markerDetail}>{formatDistance(distance)}</Text>
        ) : null}
        {distanceToDestination !== null ? (
          <Text style={styles.markerDetail}>
            {isLocal ? '' : `${displayName.split(' ')[0]}: `}
            {(distanceToDestination / 1000).toFixed(1)} km to destination
          </Text>
        ) : null}
      </View>
      {showHeading ? (
        <View
          style={[
            styles.markerArrow,
            { borderBottomColor: color, transform: [{ rotate: `${location.heading}deg` }] },
          ]}
        />
      ) : (
        <View style={[styles.markerPin, { backgroundColor: color }]}>
          <View style={styles.markerPinCore} />
        </View>
      )}
    </View>
  );
}

function DestinationMarker({ name }: { name: string | null }) {
  return (
    <View style={styles.markerWrap}>
      <View style={styles.markerCard}>
        <Text style={styles.markerName} numberOfLines={2}>
          {name?.trim() || 'Destination'}
        </Text>
        <Text style={styles.markerDetail}>Ride destination</Text>
      </View>
      <View style={styles.destinationPin}>
        <Text style={styles.destinationPinText}>END</Text>
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
    bottom: spacing.lg,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  controlButton: {
    backgroundColor: uiColor.surface,
    borderWidth: 1,
    borderColor: uiColor.borderStrong,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  controlButtonDisabled: {
    opacity: 0.5,
  },
  controlButtonText: {
    color: uiColor.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  statusOverlay: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: uiColor.surface,
    borderWidth: 1,
    borderColor: uiColor.border,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  statusOverlayText: {
    color: uiColor.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  routeStatusOverlay: {
    position: 'absolute',
    top: 64,
    left: 12,
    right: 12,
    minHeight: 38,
    backgroundColor: uiColor.surface,
    borderWidth: 1,
    borderColor: uiColor.border,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  routeStatusText: { color: uiColor.textSecondary, fontSize: 12, fontWeight: '600', flex: 1 },
  routeRetryText: { color: uiColor.accent, fontSize: 12, fontWeight: '700' },
  markerWrap: {
    alignItems: 'center',
    maxWidth: 180,
  },
  markerOffline: {
    opacity: 0.55,
  },
  markerCard: {
    backgroundColor: '#ffffff',
    borderRadius: radius.sm,
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
  markerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fallingBehindBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
    backgroundColor: '#dc2626',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
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
  /** CSS-triangle trick: a 0x0 box with transparent left/right borders and a
   * colored bottom border renders as an upward-pointing triangle -- rotated by
   * the rider's true compass heading (0deg = north = "up", clockwise), which
   * matches how `rotate` transforms work in RN. */
  markerArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 18,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  destinationPin: {
    minWidth: 32,
    height: 24,
    borderRadius: radius.sm,
    backgroundColor: uiColor.accent,
    borderWidth: 2,
    borderColor: uiColor.onAccent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  destinationPinText: {
    ...type.overline,
    fontSize: 8,
    lineHeight: 10,
    color: uiColor.onAccent,
  },
});
