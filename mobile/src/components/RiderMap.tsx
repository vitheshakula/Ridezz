import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementRef,
} from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
} from '@maplibre/maplibre-react-native';
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
import {
  fetchRoadRouteDetailed,
  formatDuration,
  type RoadRoute,
} from '../services/routingService';
import { brand, font, homeType } from '../homeTheme';
import {
  FitIcon,
  FlagIcon,
  LocateIcon,
  MicIcon,
  MinusIcon,
  PlusIcon,
} from './HomeIcons';
import { Logo } from './Logo';

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
  /** Space the floating HUD / bottom panel occupy, so map overlays and camera fits stay clear of them. */
  topInset?: number;
  bottomInset?: number;
  /** Identities LiveKit currently reports as speaking (drives the talking marker state). */
  speakingIdentities?: string[];
  /** Host-only: opens the existing "Change destination" editor. */
  onChangeDestination?: () => void;
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
const LOCAL_RIDER_COLOR = brand.primary;

const MAP_STATUS_TICK_MS = 5000;
const CAMERA_ANIMATION_MS = 400;
const CENTER_ZOOM = 15;
const INITIAL_ZOOM = 13;
const ROUTE_RETRY_MS = 10_000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;
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

function toLngLat(
  location: Pick<RiderLocation, 'latitude' | 'longitude'>,
): LngLat {
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

export default function RiderMap({
  locations,
  localIdentity,
  statusMessage,
  destination,
  topInset = 0,
  bottomInset = 0,
  speakingIdentities,
  onChangeDestination,
}: RiderMapProps) {
  const cameraRef = useRef<ElementRef<typeof Camera>>(null);
  const zoomRef = useRef(INITIAL_ZOOM);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const validLocations = useMemo(
    () => locations.filter(hasValidCoordinate),
    [locations],
  );
  const localLocation =
    validLocations.find(l => l.participantIdentity === localIdentity) ?? null;
  const destinationLngLat: LngLat | null = useMemo(
    () => (destination ? [destination.longitude, destination.latitude] : null),
    [destination],
  );

  // "Falling behind" is judged against the live/stale group, not riders who've
  // dropped off the map entirely -- an offline rider's stale last-known position
  // shouldn't drag the centroid toward them or get flagged itself.
  const activeLocations = useMemo(
    () =>
      validLocations.filter(
        location => classifyFreshness(location, nowMs) !== 'offline',
      ),
    [validLocations, nowMs],
  );
  const groupCentroid = useMemo(
    () => computeCentroid(activeLocations),
    [activeLocations],
  );

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
      meters < 1000
        ? `${Math.round(meters)} m direct`
        : `${(meters / 1000).toFixed(1)} km direct`;
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
  const [routeStatus, setRouteStatus] = useState<
    'idle' | 'loading' | 'road' | 'fallback'
  >('idle');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeRetry, setRouteRetry] = useState(0);
  const lastSuccessfulRouteRef = useRef<{
    from: LngLat;
    destination: LngLat;
  } | null>(null);
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
      !last ||
      last.destination[0] !== destinationLngLat[0] ||
      last.destination[1] !== destinationLngLat[1];
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
          retryTimer = setTimeout(
            () => setRouteRetry(value => value + 1),
            ROUTE_RETRY_MS,
          );
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
    const label = `${(roadRoute.distanceMeters / 1000).toFixed(
      1,
    )} km · ${formatDuration(roadRoute.durationSeconds)}`;
    return {
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: roadRoute.coordinates,
      },
      properties: { label },
    };
  }, [roadRoute]);

  useEffect(() => {
    const interval = setInterval(
      () => setNowMs(Date.now()),
      MAP_STATUS_TICK_MS,
    );
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
      padding: {
        top: topInset + 40,
        right: 80,
        bottom: bottomInset + 40,
        left: 40,
      },
      duration: CAMERA_ANIMATION_MS,
    });
  }, [bottomInset, destinationLngLat, nowMs, topInset, validLocations]);

  const handleZoom = useCallback((delta: number) => {
    const next = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, zoomRef.current + delta),
    );
    zoomRef.current = next;
    cameraRef.current?.zoomTo(next, { duration: CAMERA_ANIMATION_MS });
  }, []);

  const handleCenterMe = useCallback(() => {
    if (!localLocation) {
      return;
    }
    centerOnLocation(localLocation);
  }, [centerOnLocation, localLocation]);

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        mapStyle={MAPTILER_STYLE_URL}
        onRegionDidChange={event => {
          zoomRef.current = event.nativeEvent.zoom;
        }}
        onPress={() => setSelectedKey(null)}
      >
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
          <GeoJSONSource
            key="roadRoute"
            id="roadRouteSource"
            data={roadRouteGeoJSON}
          >
            <Layer
              id="roadRouteLine"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': '#3b82f6',
                'line-width': 4,
                'line-opacity': 0.85,
              }}
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
              paint={{
                'text-color': '#e5e7eb',
                'text-halo-color': '#111827',
                'text-halo-width': 1.5,
              }}
            />
          </GeoJSONSource>
        ) : straightLineGeoJSON ? (
          // Fallback while the real route hasn't loaded yet (or OSRM's public demo server
          // is unavailable) -- deliberately dashed and gray, and labeled "direct" rather than
          // with a turn-by-turn distance, so it never reads as an actual route.
          <GeoJSONSource
            key="straightLine"
            id="straightLineSource"
            data={straightLineGeoJSON}
          >
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
          const markerKey = `${
            location.participantIdentity || 'rider'
          }-${index}`;

          return (
            <Marker
              key={markerKey}
              id={markerKey}
              lngLat={toLngLat(location)}
              anchor="center"
              onPress={() =>
                setSelectedKey(current =>
                  current === markerKey ? null : markerKey,
                )
              }
            >
              <RiderMarker
                location={location}
                isLocal={isLocal}
                freshness={freshness}
                distance={distance}
                distanceToDestination={distanceToDestination}
                fallingBehind={fallingBehind}
                nowMs={nowMs}
                color={
                  isLocal
                    ? LOCAL_RIDER_COLOR
                    : colorForRider(location.participantIdentity)
                }
                selected={selectedKey === markerKey}
                talking={Boolean(
                  speakingIdentities?.includes(location.participantIdentity),
                )}
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
        <View style={[styles.statusOverlay, { top: topInset + 8 }]}>
          <Text style={styles.statusOverlayText}>{statusMessage}</Text>
        </View>
      ) : null}

      {destination ? (
        <View
          style={[styles.navCard, { top: topInset + (statusMessage ? 60 : 8) }]}
        >
          <View style={styles.navIcon}>
            <FlagIcon size={20} color={brand.primary} />
          </View>
          <View style={styles.navBody}>
            <Text style={styles.navEyebrow}>NEXT WAYPOINT</Text>
            <Text style={styles.navName} numberOfLines={1}>
              {destination.name?.trim() || 'Destination'}
            </Text>
            {localLocation ? (
              <Text style={styles.navDetail} numberOfLines={2}>
                {routeStatus === 'loading'
                  ? 'Finding road route...'
                  : routeStatus === 'road' && roadRoute
                  ? `${(roadRoute.distanceMeters / 1000).toFixed(
                      1,
                    )} km · ${formatDuration(roadRoute.durationSeconds)}`
                  : `Direct-line fallback${
                      routeError ? ` · ${routeError}` : ''
                    }`}
              </Text>
            ) : null}
          </View>
          {routeStatus === 'fallback' && localLocation ? (
            <Pressable
              style={styles.navAction}
              onPress={() => setRouteRetry(value => value + 1)}
              hitSlop={6}
            >
              <Text style={styles.navActionText}>Retry</Text>
            </Pressable>
          ) : null}
          {onChangeDestination ? (
            <Pressable
              style={styles.navAction}
              accessibilityRole="button"
              accessibilityLabel="Change destination"
              hitSlop={6}
              onPress={onChangeDestination}
            >
              <Text style={styles.navActionText}>Change</Text>
            </Pressable>
          ) : null}
        </View>
      ) : onChangeDestination ? (
        <Pressable
          style={[
            styles.setDestination,
            { top: topInset + (statusMessage ? 60 : 8) },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Change destination"
          hitSlop={6}
          onPress={onChangeDestination}
        >
          <FlagIcon size={18} color={brand.primary} />
          <Text style={styles.navActionText}>Set destination</Text>
        </Pressable>
      ) : null}

      <View style={[styles.controls, { bottom: bottomInset + 12 }]}>
        <MapControl label="Zoom in" onPress={() => handleZoom(1)}>
          <PlusIcon size={22} color={brand.textPrimary} />
        </MapControl>
        <MapControl label="Zoom out" onPress={() => handleZoom(-1)}>
          <MinusIcon size={22} color={brand.textPrimary} />
        </MapControl>
        <MapControl
          label="Center Me"
          onPress={handleCenterMe}
          disabled={!localLocation}
        >
          <LocateIcon size={22} color={brand.primary} />
        </MapControl>
        <MapControl label="Fit Group" onPress={handleFitGroup}>
          <FitIcon size={22} color={brand.primary} />
        </MapControl>
      </View>
    </View>
  );
}

function MapControl({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.controlButton,
        disabled && styles.controlButtonDisabled,
        pressed && styles.controlPressed,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </Pressable>
  );
}

/** Soft expanding ring behind a rider who is currently talking. Native-driven, and only runs
 * while `active` -- nothing animates for a quiet rider. */
function PulseRing({ color }: { color: string }) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.pulse,
        {
          borderColor: color,
          opacity: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0.7, 0],
          }),
          transform: [
            {
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 2],
              }),
            },
          ],
        },
      ]}
    />
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
  selected: boolean;
  talking: boolean;
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
  selected,
  talking,
}: RiderMarkerProps) {
  const offline = freshness === 'offline';
  const ageText = formatUpdatedAgo(nowMs - location.timestamp);
  const displayName =
    location.participantName.trim() || location.participantIdentity || 'Rider';
  const initial = displayName.charAt(0).toUpperCase() || '?';
  const showHeading =
    location.heading !== undefined &&
    location.speed !== undefined &&
    location.speed >= MIN_HEADING_SPEED_MPS &&
    !offline;

  // State is never colour-only: each non-default state also carries a text tag or glyph.
  const tag = offline
    ? 'OFFLINE'
    : fallingBehind
    ? 'FAR'
    : freshness === 'stale'
    ? 'STALE'
    : null;
  const ring = isLocal
    ? brand.primary
    : offline
    ? brand.outline
    : talking
    ? brand.success
    : fallingBehind || freshness === 'stale'
    ? brand.warning
    : brand.success;
  const tagColor = offline ? brand.outline : brand.warning;
  const firstName = displayName.split(' ')[0];

  return (
    <View style={[styles.markerBox, offline && styles.markerOffline]}>
      {selected ? (
        <View style={styles.detailCard}>
          <Text style={styles.detailName} numberOfLines={1}>
            {displayName}
            {isLocal ? ' (you)' : ''}
          </Text>
          <Text
            style={[
              styles.detailLine,
              { color: offline ? brand.outline : brand.success },
            ]}
          >
            {offline ? 'Offline' : talking ? 'Talking' : 'Online'} · {ageText}
          </Text>
          {location.speed !== undefined ? (
            <Text style={styles.detailLine}>{formatSpeed(location.speed)}</Text>
          ) : null}
          {location.accuracy !== undefined ? (
            <Text style={styles.detailLine}>
              Accuracy +/-{Math.round(location.accuracy)}m
            </Text>
          ) : null}
          {distance !== null ? (
            <Text style={styles.detailLine}>{formatDistance(distance)}</Text>
          ) : null}
          {distanceToDestination !== null ? (
            <Text style={styles.detailLine}>
              {isLocal ? '' : `${firstName}: `}
              {(distanceToDestination / 1000).toFixed(1)} km to destination
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.namePill}>
          <Text style={styles.namePillText} numberOfLines={1}>
            {isLocal ? 'You' : firstName}
            {distance !== null ? `  ${formatDistance(distance)}` : ''}
          </Text>
          {tag ? (
            <Text style={[styles.tagText, { color: tagColor }]}>{tag}</Text>
          ) : null}
        </View>
      )}

      {isLocal ? <View style={styles.localAura} /> : null}
      {talking && !offline ? <PulseRing color={brand.success} /> : null}
      {showHeading ? (
        <View
          style={[
            styles.headingArrow,
            {
              borderBottomColor: color,
              transform: [{ rotate: `${location.heading}deg` }],
            },
          ]}
        />
      ) : null}
      <View
        style={[
          styles.avatar,
          { borderColor: ring },
          selected && styles.avatarSelected,
        ]}
      >
        {isLocal ? (
          <Logo size={22} />
        ) : (
          <Text style={[styles.avatarInitial, { color }]}>{initial}</Text>
        )}
      </View>
      {talking && !offline ? (
        <View style={styles.talkBadge}>
          <MicIcon size={10} color={brand.darkest} />
        </View>
      ) : null}
    </View>
  );
}

function DestinationMarker({ name }: { name: string | null }) {
  return (
    <View style={styles.destinationWrap}>
      <View style={styles.namePill}>
        <Text style={styles.namePillText} numberOfLines={2}>
          {name?.trim() || 'Destination'}
        </Text>
      </View>
      <View style={styles.destinationPin}>
        <FlagIcon size={16} color={brand.onPrimary} />
      </View>
    </View>
  );
}

const MARKER_SIZE = 40;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  controls: {
    position: 'absolute',
    right: 12,
    gap: 8,
  },
  controlButton: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(17, 25, 35, 0.92)',
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  controlButtonDisabled: {
    opacity: 0.45,
  },
  controlPressed: { backgroundColor: brand.surfaceHigh },
  statusOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: 'rgba(17, 25, 35, 0.92)',
    borderWidth: 1,
    borderColor: brand.inputBorder,
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  statusOverlayText: {
    ...homeType.labelMedium,
    color: brand.textSecondary,
    textAlign: 'center',
  },
  navCard: {
    position: 'absolute',
    left: 12,
    right: 72,
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(17, 25, 35, 0.94)',
    borderWidth: 1,
    borderColor: brand.inputBorder,
    borderRadius: 16,
    padding: 10,
  },
  navIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: brand.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBody: { flex: 1 },
  navEyebrow: { ...homeType.labelSmall, color: brand.primary },
  navName: {
    fontFamily: font.heading,
    fontSize: 15,
    lineHeight: 20,
    color: brand.textPrimary,
  },
  navDetail: { ...homeType.bodySmall, color: brand.textSecondary },
  navAction: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  navActionText: { ...homeType.labelMedium, color: brand.primary },
  setDestination: {
    position: 'absolute',
    left: 12,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(17, 25, 35, 0.94)',
    borderWidth: 1,
    borderColor: brand.primaryBorder,
  },
  markerBox: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerOffline: {
    opacity: 0.6,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 3,
    backgroundColor: brand.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarSelected: { transform: [{ scale: 1.15 }] },
  avatarInitial: { fontFamily: font.heading, fontSize: 14, lineHeight: 18 },
  localAura: {
    position: 'absolute',
    width: MARKER_SIZE + 16,
    height: MARKER_SIZE + 16,
    borderRadius: (MARKER_SIZE + 16) / 2,
    backgroundColor: 'rgba(18, 207, 228, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(18, 207, 228, 0.35)',
  },
  pulse: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
  },
  talkBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: brand.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** CSS-triangle trick: a 0x0 box with transparent left/right borders and a colored bottom
   * border renders as an upward-pointing triangle, rotated by the rider's compass heading
   * (0deg = north = "up", clockwise). Sits just outside the avatar ring. */
  headingArrow: {
    position: 'absolute',
    top: -6,
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 11,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  namePill: {
    position: 'absolute',
    bottom: MARKER_SIZE - 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 170,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(7, 15, 24, 0.92)',
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  namePillText: {
    ...homeType.labelMedium,
    color: brand.textPrimary,
    flexShrink: 1,
  },
  tagText: { ...homeType.labelSmall },
  detailCard: {
    position: 'absolute',
    bottom: MARKER_SIZE - 2,
    minWidth: 150,
    padding: 10,
    borderRadius: 14,
    backgroundColor: brand.card,
    borderWidth: 1,
    borderColor: brand.primaryBorder,
  },
  detailName: {
    fontFamily: font.heading,
    fontSize: 14,
    lineHeight: 18,
    color: brand.textPrimary,
  },
  detailLine: { ...homeType.bodySmall, color: brand.textSecondary },
  destinationWrap: { alignItems: 'center', maxWidth: 180 },
  destinationPin: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: brand.primary,
    borderWidth: 3,
    borderColor: brand.darkest,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
