import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Callout, Marker } from 'react-native-maps';
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
}

const FRESHNESS_COLOR: Record<string, string> = {
  live: '#3fb950',
  stale: '#d29922',
  offline: '#6b7280',
};

export default function RiderMap({ locations, localIdentity }: RiderMapProps) {
  const mapRef = useRef<MapView>(null);
  const localLocation = locations.find(l => l.participantIdentity === localIdentity) ?? null;

  // MapView's initialRegion prop only applies once at mount, and localLocation is
  // typically still null at that point (the first GPS fix hasn't arrived yet). Center on
  // it a single time, as soon as it does -- this is an initial placement, not the
  // continuous auto-fit the task explicitly avoids.
  const hasCenteredOnceRef = useRef(false);
  useEffect(() => {
    if (hasCenteredOnceRef.current || !localLocation) {
      return;
    }
    hasCenteredOnceRef.current = true;
    mapRef.current?.animateToRegion(
      {
        latitude: localLocation.latitude,
        longitude: localLocation.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      },
      400,
    );
  }, [localLocation]);

  const handleFitGroup = useCallback(() => {
    if (locations.length === 0) {
      return;
    }
    mapRef.current?.fitToCoordinates(
      locations.map(l => ({ latitude: l.latitude, longitude: l.longitude })),
      { edgePadding: { top: 80, right: 80, bottom: 80, left: 80 }, animated: true },
    );
  }, [locations]);

  const handleCenterMe = useCallback(() => {
    if (!localLocation) {
      return;
    }
    mapRef.current?.animateToRegion(
      {
        latitude: localLocation.latitude,
        longitude: localLocation.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      },
      400,
    );
  }, [localLocation]);

  const initialRegion = localLocation
    ? {
        latitude: localLocation.latitude,
        longitude: localLocation.longitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      }
    : undefined;

  return (
    <View style={styles.container}>
      <MapView ref={mapRef} style={styles.map} initialRegion={initialRegion}>
        {locations.map(location => {
          const isLocal = location.participantIdentity === localIdentity;
          const freshness = classifyFreshness(location, Date.now());
          const distance =
            !isLocal && localLocation
              ? haversineDistanceMeters(localLocation, location)
              : null;

          return (
            <Marker
              key={location.participantIdentity}
              coordinate={{ latitude: location.latitude, longitude: location.longitude }}
              pinColor={isLocal ? '#2f81f7' : FRESHNESS_COLOR[freshness]}
              opacity={freshness === 'offline' ? 0.5 : 1}
            >
              <RiderCallout
                location={location}
                isLocal={isLocal}
                freshness={freshness}
                distance={distance}
              />
            </Marker>
          );
        })}
      </MapView>

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

interface RiderCalloutProps {
  location: RiderLocation;
  isLocal: boolean;
  freshness: 'live' | 'stale' | 'offline';
  distance: number | null;
}

function RiderCallout({ location, isLocal, freshness, distance }: RiderCalloutProps) {
  const statusText = freshness === 'offline' ? 'Offline' : 'Online';
  const ageText = formatUpdatedAgo(Date.now() - location.timestamp);

  return (
    <Callout tooltip={false} style={styles.callout}>
      <View style={styles.calloutContent}>
        <Text style={styles.calloutName}>
          {location.participantName}
          {isLocal ? ' (you)' : ''}
        </Text>
        <Text style={styles.calloutDetail}>{statusText}</Text>
        <Text style={styles.calloutDetail}>{ageText}</Text>
        {location.accuracy !== undefined ? (
          <Text style={styles.calloutDetail}>Accuracy ±{Math.round(location.accuracy)}m</Text>
        ) : null}
        {distance !== null ? (
          <Text style={styles.calloutDetail}>{formatDistance(distance)}</Text>
        ) : null}
      </View>
    </Callout>
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
  callout: {
    minWidth: 150,
  },
  calloutContent: {
    padding: 4,
  },
  calloutName: {
    fontWeight: '700',
    fontSize: 15,
    marginBottom: 2,
  },
  calloutDetail: {
    fontSize: 12,
    color: '#57606a',
  },
});
