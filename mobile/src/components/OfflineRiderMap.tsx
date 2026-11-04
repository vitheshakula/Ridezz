import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, Marker } from '@maplibre/maplibre-react-native';
import { colorForRider, type RideDestination } from './RiderMap';
import { FitIcon, FlagIcon, LocateIcon, MinusIcon, PlusIcon } from './HomeIcons';
import { Logo } from './Logo';
import { haversineDistanceMeters } from '../utils/geoMath';
import { formatDistance } from '../utils/riderLocation';
import { OffRouteTracker, type OffRouteState } from '../utils/routeDeviation';
import { brand, font, homeType } from '../homeTheme';
import type { GeoPoint, RiderNode } from '../types/telemetry';

type LngLat = [number, number];

export interface OfflineRiderMapProps {
  riders: RiderNode[];
  mapStyleUrl: string;
  initialCenter?: GeoPoint;
  initialZoom?: number;
  topInset?: number;
  bottomInset?: number;
  selfRiderId?: string;
  selfLocation?: GeoPoint | null;
  destination?: RideDestination | null;
  routeGeometry?: GeoJSON.LineString | null;
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

export default function OfflineRiderMap({
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
  const autoFollowRef = useRef(true);

  const shown = useMemo(
    () => (selfRiderId === undefined ? riders : riders.filter(r => r.riderId !== selfRiderId)),
    [riders, selfRiderId],
  );

  const destinationLngLat: LngLat | null = useMemo(
    () => (destination ? [destination.longitude, destination.latitude] : null),
    [destination],
  );

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
    const routePoints: GeoPoint[] = routeGeometry.coordinates.map(([longitude, latitude]) => ({
      latitude,
      longitude,
    }));
    const state = offRouteTrackerRef.current.update(selfLocation, routePoints);
    setOffRouteState(state);
    if (state.justChanged) {
      onOffRouteChange?.(state.isOffRoute);
    }
  }, [selfLocation, routeGeometry, onOffRouteChange]);

  const rejoinGuidanceFeature = useMemo((): GeoJSON.Feature<GeoJSON.LineString> | null => {
    if (!offRouteState?.isOffRoute || !offRouteState.nearestPoint || !selfLocation) {
      return null;
    }
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [toLngLat(selfLocation), toLngLat(offRouteState.nearestPoint)],
      },
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
    cameraRef.current?.easeTo({
      center: toLngLat(selfLocation),
      zoom: CENTER_ME_ZOOM,
      duration: CAMERA_ANIMATION_MS,
    });
  }, [selfLocation]);

  const handleGroupMe = useCallback(() => {
    autoFollowRef.current = false;
    const points: LngLat[] = [...(selfLocation ? [selfLocation] : []), ...shown].map(toLngLat);
    if (points.length === 0) {
      return;
    }
    const bounds = getPointsBounds(points);
    if (points.length === 1 || areBoundsTooTight(bounds)) {
      cameraRef.current?.easeTo({
        center: getBoundsCenter(bounds),
        zoom: FIT_GROUP_SINGLE_ZOOM,
        duration: CAMERA_ANIMATION_MS,
      });
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
            initialCenter ? { center: toLngLat(initialCenter), zoom: initialZoom } : { zoom: 2 }
          }
        />

        {routeFeature ? (
          <GeoJSONSource id="offlineRoute" data={routeFeature}>
            <Layer
              id="offlineRouteLine"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
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
              <OfflineRiderMarker
                rider={rider}
                color={colorForRider(rider.riderId)}
                distance={distance}
              />
            </Marker>
          );
        })}

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

function OfflineSelfMarker() {
  return (
    <View style={styles.markerStack}>
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
