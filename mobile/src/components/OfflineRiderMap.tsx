import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, Marker } from '@maplibre/maplibre-react-native';
import { colorForRider, type RideDestination } from './RiderMap';
import { FitIcon, FlagIcon, LocateIcon, MinusIcon, PlusIcon } from './HomeIcons';
import { Logo } from './Logo';
import { renderPackAlertPins } from './PackAlertPin';
import type { PackAlert } from '../convoy/packAlerts';
import { haversineDistanceMeters } from '../utils/geoMath';
import { formatDistance } from '../utils/riderLocation';
import { OffRouteTracker, type OffRouteState } from '../utils/routeDeviation';
import { brand, font, homeType } from '../homeTheme';
import type { GeoPoint, RiderNode } from '../types/telemetry';

type LngLat = [number, number];

export interface OfflineRiderMapProps {
  /** Convoy alerts: a pin at each rider's last known position. */
  alertPins?: readonly PackAlert[];
  /** Every rider meshSyncManager currently knows a position for -- pass its getKnownRiders(), kept
   * in the parent's own state and refreshed from the manager's onRidersChanged callback. This
   * component only renders what it's given; it doesn't own or talk to the mesh manager itself. */
  riders: RiderNode[];
  /** Point this at the exact same style URL used to download an offline pack (see
   * offlineMapManager.ts and RiderMap's exported MAPTILER_STYLE_URL). MapLibre serves that pack's
   * cached tiles for a matching style with no connectivity and no special code here. */
  mapStyleUrl: string;
  initialCenter?: GeoPoint;
  initialZoom?: number;
  /** Space the floating HUD / bottom panel occupy, so the control buttons stay clear of them --
   * same purpose as RiderMap's identically-named props. */
  topInset?: number;
  bottomInset?: number;
  /** This device's own riderId, so its own marker is never drawn from a stray echo. `riders` never
   * actually contains self (meshSyncManager only tracks other riders), so this is a defensive
   * filter, not the normal path. */
  selfRiderId?: string;
  /** This device's current GPS fix, if any -- drives each rider's "how far from me" label, the
   * straight-line fallback route to `destination`, and what "Center Me" / "Group Me" use. Omit
   * while no fix is available yet. Unlike RiderMap's own Center Me, this component never fetches a
   * fresh fix itself (it has no location access of its own) -- it re-centers on whatever this prop
   * most recently carried, which the parent is already refreshing continuously. */
  selfLocation?: GeoPoint | null;
  /** The active ride destination, carried over from the online map so it doesn't vanish the
   * moment the app falls back to mesh-only. */
  destination?: RideDestination | null;
  /** A cached road-route geometry (e.g. RiderMap's last successful OSRM fetch) to keep showing
   * while offline -- this component never fetches a route itself, since there's no connectivity to
   * assume. Falls back to a straight ("as the crow flies") line from selfLocation to destination
   * when omitted. Off-route detection (below) only runs against a real route here, never the
   * straight-line fallback -- a rider is trivially "off" a pure point-to-point line at all times,
   * so checking against it would do nothing but false-positive. */
  routeGeometry?: GeoJSON.LineString | null;
  /** Fires once per on-route/off-route transition (not on every fix) -- the parent decides what to
   * do with it (RideScreen speaks an alert). This component only detects and reports; it has no
   * TTS/audio access of its own, consistent with it only ever rendering what it's given. */
  onOffRouteChange?: (isOffRoute: boolean) => void;
}

const DEFAULT_ZOOM = 13;
const MARKER_SIZE = 40;
const MIN_ZOOM = 1;
const MAX_ZOOM = 20;
const CAMERA_ANIMATION_MS = 400;
const CENTER_ME_ZOOM = 17;
const FIT_GROUP_SINGLE_ZOOM = 14;
const FIT_GROUP_MARGIN = 80;

function toLngLat(point: GeoPoint): LngLat {
  return [point.longitude, point.latitude];
}

function getPointsBounds(points: LngLat[]): [number, number, number, number] {
  const longitudes = points.map(p => p[0]);
  const latitudes = points.map(p => p[1]);
  return [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
}

function getBoundsCenter(bounds: [number, number, number, number]): LngLat {
  const [west, south, east, north] = bounds;
  return [(west + east) / 2, (south + north) / 2];
}

function areBoundsTooTight(bounds: [number, number, number, number]): boolean {
  const [west, south, east, north] = bounds;
  return Math.abs(east - west) < 0.0001 && Math.abs(north - south) < 0.0001;
}

/**
 * Offline-first rider map: plots whoever meshSyncManager currently has a position for, plus the
 * active destination and route, from pure props -- no mesh/location access of its own. "Offline"
 * describes the map tiles (via mapStyleUrl pointing at an OfflineManager-downloaded pack) and the
 * data source (the mesh, not LiveKit), not a claim that this component does its own offline
 * detection.
 *
 * Markers deliberately mirror RiderMap's avatar + name-pill look (same colours, sizes and theme
 * tokens via colorForRider/brand/font) so switching between the cloud and offline map mid-ride
 * doesn't also switch the visual language. Unlike RiderMap, a rider's name is never a raw id or
 * hash: `riderName` is carried on the wire precisely so this map never has to show one. The zoom /
 * center / group map controls are the same RiderMap behaviours, reimplemented against this
 * component's own camera ref since the two maps are never mounted at the same time.
 */
export default function OfflineRiderMap({
  alertPins,
  riders,
  mapStyleUrl,
  initialCenter,
  initialZoom = DEFAULT_ZOOM,
  topInset = 0,
  bottomInset = 0,
  selfRiderId,
  selfLocation,
  destination,
  routeGeometry,
  onOffRouteChange,
}: OfflineRiderMapProps) {
  const cameraRef = useRef<ElementRef<typeof Camera>>(null);
  const zoomRef = useRef(initialZoom);
  // Follows this device's live position as selfLocation updates -- the initial placement is
  // handled declaratively by Camera's initialViewState below, so this only re-centers on fixes
  // after that. Any manual map gesture switches it off (same behaviour as RiderMap's own
  // auto-follow); "Center Me" is the only thing that switches it back on.
  const autoFollowRef = useRef(true);

  const shown = useMemo(
    () => (selfRiderId === undefined ? riders : riders.filter(r => r.riderId !== selfRiderId)),
    [riders, selfRiderId],
  );

  const destinationLngLat: LngLat | null = useMemo(
    () => (destination ? [destination.longitude, destination.latitude] : null),
    [destination],
  );

  // A real road route is shown when the parent hands one over (carried from the online map);
  // otherwise fall back to a straight guide line, same as RiderMap does while its own route hasn't
  // loaded yet -- this component has no connectivity to fetch one itself.
  const routeFeature = useMemo((): GeoJSON.Feature<GeoJSON.LineString> | null => {
    if (routeGeometry) {
      return { type: 'Feature', properties: {}, geometry: routeGeometry };
    }
    if (!selfLocation || !destinationLngLat) {
      return null;
    }
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [toLngLat(selfLocation), destinationLngLat] },
    };
  }, [routeGeometry, selfLocation, destinationLngLat]);

  useEffect(() => {
    if (selfLocation && autoFollowRef.current) {
      cameraRef.current?.easeTo({ center: toLngLat(selfLocation), duration: CAMERA_ANIMATION_MS });
    }
  }, [selfLocation]);

  // Off-route detection: debounced (OffRouteTracker) so one stray GPS fix can't trigger a false
  // "off route" alert, and reset whenever the destination itself changes so a genuinely new route
  // starts its own debounce window instead of inheriting the old route's streak.
  const offRouteTrackerRef = useRef(new OffRouteTracker());
  const [offRouteState, setOffRouteState] = useState<OffRouteState | null>(null);
  useEffect(() => {
    offRouteTrackerRef.current.reset();
    setOffRouteState(null);
  }, [destination?.latitude, destination?.longitude]);

  useEffect(() => {
    if (!selfLocation || !routeGeometry) {
      return;
    }
    const routePoints: GeoPoint[] = routeGeometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude }));
    const state = offRouteTrackerRef.current.update(selfLocation, routePoints);
    setOffRouteState(state);
    if (state.justChanged) {
      onOffRouteChange?.(state.isOffRoute);
    }
  }, [selfLocation, routeGeometry, onOffRouteChange]);

  // A dashed guide from the rider's current position back to the nearest point on the cached
  // route -- the "snap-to-nearest-corridor" rejoin guidance: there's no offline routing engine
  // packaged in this app to calculate a genuinely new path, so this points at getting back onto
  // the one already cached rather than pretending to replace it.
  const rejoinGuidanceFeature = useMemo((): GeoJSON.Feature<GeoJSON.LineString> | null => {
    if (!offRouteState?.isOffRoute || !offRouteState.nearestPoint || !selfLocation) {
      return null;
    }
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [toLngLat(selfLocation), toLngLat(offRouteState.nearestPoint)] },
    };
  }, [offRouteState, selfLocation]);

  const handleZoom = useCallback((delta: number) => {
    autoFollowRef.current = false;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current + delta));
    zoomRef.current = next;
    cameraRef.current?.zoomTo(next, { duration: CAMERA_ANIMATION_MS });
  }, []);

  const handleCenterMe = useCallback(() => {
    autoFollowRef.current = true;
    if (!selfLocation) {
      return;
    }
    cameraRef.current?.easeTo({ center: toLngLat(selfLocation), zoom: CENTER_ME_ZOOM, duration: CAMERA_ANIMATION_MS });
  }, [selfLocation]);

  const handleGroupMe = useCallback(() => {
    autoFollowRef.current = false;
    const points: LngLat[] = [...(selfLocation ? [selfLocation] : []), ...shown].map(toLngLat);
    if (points.length === 0) {
      return;
    }
    const bounds = getPointsBounds(points);
    if (points.length === 1 || areBoundsTooTight(bounds)) {
      cameraRef.current?.easeTo({ center: getBoundsCenter(bounds), zoom: FIT_GROUP_SINGLE_ZOOM, duration: CAMERA_ANIMATION_MS });
      return;
    }
    cameraRef.current?.fitBounds(bounds, {
      padding: {
        top: topInset + FIT_GROUP_MARGIN,
        right: FIT_GROUP_MARGIN,
        bottom: bottomInset + FIT_GROUP_MARGIN,
        left: FIT_GROUP_MARGIN,
      },
      duration: CAMERA_ANIMATION_MS,
    });
  }, [selfLocation, shown, topInset, bottomInset]);

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        mapStyle={mapStyleUrl}
        onRegionWillChange={event => {
          // Switch auto-follow off the instant a drag/pinch/rotate starts -- not onRegionDidChange,
          // which only fires once the gesture has already finished moving the camera around.
          if (event.nativeEvent.userInteraction) {
            autoFollowRef.current = false;
          }
        }}
        onRegionDidChange={event => {
          zoomRef.current = event.nativeEvent.zoom;
        }}
      >
        <Camera
          ref={cameraRef}
          initialViewState={
            initialCenter
              ? { center: toLngLat(initialCenter), zoom: initialZoom }
              : { zoom: 2 }
          }
        />

        {routeFeature ? (
          <GeoJSONSource id="offlineRoute" data={routeFeature}>
            <Layer
              id="offlineRouteLine"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              // Two full paint objects, never one with an `undefined` property -- Fabric's typed
              // native props can reject an explicit undefined/null where a value (or the key's
              // plain absence) is expected, unlike the old bridge which just dropped it silently.
              paint={
                routeGeometry
                  ? { 'line-color': brand.primary, 'line-width': 4 }
                  : { 'line-color': brand.outline, 'line-width': 3, 'line-dasharray': [2, 2] }
              }
            />
          </GeoJSONSource>
        ) : null}

        {rejoinGuidanceFeature ? (
          <GeoJSONSource id="offlineRejoinGuidance" data={rejoinGuidanceFeature}>
            <Layer
              id="offlineRejoinGuidanceLine"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': brand.warning, 'line-width': 3, 'line-dasharray': [1, 1] }}
            />
          </GeoJSONSource>
        ) : null}

        {shown.map(rider => {
          const distance = selfLocation ? haversineDistanceMeters(selfLocation, rider) : null;
          return (
            <Marker key={rider.riderId} id={rider.riderId} lngLat={toLngLat(rider)} anchor="bottom">
              <OfflineRiderMarker rider={rider} color={colorForRider(rider.riderId)} distance={distance} />
            </Marker>
          );
        })}

        {renderPackAlertPins(alertPins)}

        {destinationLngLat ? (
          <Marker id="destination" lngLat={destinationLngLat} anchor="bottom">
            <OfflineDestinationMarker name={destination?.name ?? null} />
          </Marker>
        ) : null}

        {selfLocation ? (
          <Marker id="self" lngLat={toLngLat(selfLocation)} anchor="bottom">
            <OfflineSelfMarker />
          </Marker>
        ) : null}
      </Map>

      <View style={[styles.controls, { bottom: bottomInset + 12 }]}>
        <MapControl label="Zoom in" onPress={() => handleZoom(1)}>
          <PlusIcon size={22} color={brand.textPrimary} />
        </MapControl>
        <MapControl label="Zoom out" onPress={() => handleZoom(-1)}>
          <MinusIcon size={22} color={brand.textPrimary} />
        </MapControl>
        <MapControl label="Center Me" onPress={handleCenterMe} disabled={!selfLocation}>
          <LocateIcon size={22} color={brand.primary} />
        </MapControl>
        <MapControl label="Group Me" onPress={handleGroupMe}>
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
      style={({ pressed }) => [styles.controlButton, disabled && styles.controlButtonDisabled, pressed && styles.controlPressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </Pressable>
  );
}

// The label (namePill) is a normal in-flow sibling stacked above markerBox, not an
// absolutely-positioned overlay inside it -- a label floating outside its parent's own bounds
// inside a native marker-annotation host view is what caused both an earlier truncation bug and,
// once numberOfLines was removed to stop that, letters wrapping one-per-line instead. Normal flow
// layout has no such edge case. Markers use anchor="bottom" (not "center") to compensate for the
// stack now being taller than just the avatar -- matches RiderMap's own marker structure.

/** This device's own position -- unlike peers in `riders` (which meshSyncManager never includes
 * self in), self has to be drawn explicitly. Mirrors RiderMap's own "You" marker: the app logo in
 * place of an initial letter, the primary brand colour as the ring, same pill label underneath. */
function OfflineSelfMarker() {
  return (
    <View style={styles.markerStack}>
      {/* No numberOfLines here deliberately -- see the comment above this component. */}
      <View style={styles.namePill}>
        <Text style={styles.namePillText}>You</Text>
      </View>
      <View style={styles.markerBox}>
        <View style={[styles.avatar, { borderColor: brand.primary }]}>
          <Logo size={22} />
        </View>
      </View>
    </View>
  );
}

function OfflineRiderMarker({
  rider,
  color,
  distance,
}: {
  rider: RiderNode;
  color: string;
  distance: number | null;
}) {
  // Never the raw riderId: it's a random per-session token, not an identity anyone should see.
  const displayName = rider.riderName?.trim() || 'Rider';
  const initial = displayName.charAt(0).toUpperCase() || '?';

  return (
    <View style={styles.markerStack}>
      <View style={styles.namePill}>
        <Text style={styles.namePillText}>
          {displayName}
          {distance !== null ? `  ${formatDistance(distance)}` : ''}
        </Text>
      </View>
      <View style={styles.markerBox}>
        <View style={[styles.avatar, { borderColor: color }]}>
          <Text style={[styles.avatarInitial, { color }]}>{initial}</Text>
        </View>
      </View>
    </View>
  );
}

function OfflineDestinationMarker({ name }: { name: string | null }) {
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

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  // Plain column flow, sized to its content -- deliberately not position:'absolute' anywhere
  // inside it; see the comment above OfflineSelfMarker.
  markerStack: {
    alignItems: 'center',
  },
  markerBox: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
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
  avatarInitial: { fontFamily: font.heading, fontSize: 14, lineHeight: 18 },
  namePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 44,
    maxWidth: 200,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(7, 15, 24, 0.92)',
    borderWidth: 1,
    borderColor: brand.inputBorder,
  },
  // flexShrink: 0 -- the label is never squeezed smaller by anything sharing this row; the pill
  // grows (up to maxWidth above) to fit it instead.
  namePillText: { ...homeType.labelMedium, color: brand.textPrimary, flexShrink: 0 },
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
});
