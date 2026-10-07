import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import OfflineRiderMap from '../src/components/OfflineRiderMap';
import type { RiderNode } from '../src/types/telemetry';

const rider = (over: Partial<RiderNode> = {}): RiderNode => ({
  riderId: 'alex',
  riderName: 'Alex',
  latitude: 17.385,
  longitude: 78.4867,
  timestampMs: 1_700_000_000_000,
  ...over,
});

function render(props: Partial<React.ComponentProps<typeof OfflineRiderMap>> = {}) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <OfflineRiderMap riders={[]} mapStyleUrl="https://example.com/style.json" {...props} />,
    );
  });
  return renderer.root;
}

/** The mocked Marker is a plain View carrying the real `id`/`lngLat` props, with this component's
 * own marker content as children -- see __mocks__/@maplibre/maplibre-react-native.tsx. */
const markerFor = (root: ReactTestRenderer.ReactTestInstance, id: string) =>
  root.findAll(node => node.props.id === id && node.props.lngLat !== undefined)[0];

const geoJsonSource = (root: ReactTestRenderer.ReactTestInstance, id: string) =>
  root.findAll(node => node.props.id === id)[0];

function textsIn(node: ReactTestRenderer.ReactTestInstance): string[] {
  return node.findAllByType(Text).map(t => (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children)));
}

describe('OfflineRiderMap: rider markers', () => {
  it('renders no rider markers when given none', () => {
    const root = render({ riders: [] });
    expect(root.findAll(node => node.props.lngLat !== undefined && node.props.id !== 'destination')).toHaveLength(0);
  });

  it('places a rider marker at their [longitude, latitude]', () => {
    const root = render({ riders: [rider({ riderId: 'alex', latitude: 17.385, longitude: 78.4867 })] });
    expect(markerFor(root, 'alex').props.lngLat).toEqual([78.4867, 17.385]);
  });

  it('labels the marker with the rider\'s real name, never the raw riderId', () => {
    const root = render({ riders: [rider({ riderId: 'a1b2c3', riderName: 'Jaswant' })] });
    const texts = textsIn(markerFor(root, 'a1b2c3'));
    expect(texts.some(t => t.includes('Jaswant'))).toBe(true);
    expect(texts.some(t => t.includes('a1b2c3'))).toBe(false);
  });

  it('falls back to "Rider" (never the riderId) when no name is known yet', () => {
    const root = render({ riders: [rider({ riderId: 'a1b2c3', riderName: undefined })] });
    const texts = textsIn(markerFor(root, 'a1b2c3'));
    expect(texts.some(t => t.includes('Rider'))).toBe(true);
    expect(texts.some(t => t.includes('a1b2c3'))).toBe(false);
  });

  it('updates markers when the riders prop changes', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <OfflineRiderMap riders={[rider({ riderId: 'alex' })]} mapStyleUrl="https://example.com/style.json" />,
      );
    });
    ReactTestRenderer.act(() => {
      renderer.update(
        <OfflineRiderMap
          riders={[rider({ riderId: 'alex' }), rider({ riderId: 'bilal', riderName: 'Bilal' })]}
          mapStyleUrl="https://example.com/style.json"
        />,
      );
    });
    expect(markerFor(renderer.root, 'alex')).toBeTruthy();
    expect(markerFor(renderer.root, 'bilal')).toBeTruthy();
  });

  it('shows distance from self once selfLocation is given', () => {
    const root = render({
      riders: [rider({ riderId: 'alex', latitude: 17.4, longitude: 78.5 })],
      selfLocation: { latitude: 17.385, longitude: 78.4867 },
    });
    const texts = textsIn(markerFor(root, 'alex')).join(' ');
    expect(texts).toMatch(/km|m/);
  });

  it('excludes this device\'s own entry when selfRiderId is given', () => {
    const self = rider({ riderId: 'self', riderName: 'Me' });
    const other = rider({ riderId: 'bilal', riderName: 'Bilal' });
    const root = render({ riders: [self, other], selfRiderId: 'self' });
    expect(markerFor(root, 'self')).toBeUndefined();
    expect(markerFor(root, 'bilal')).toBeTruthy();
  });

  it('shows every rider, self included, when selfRiderId is not given', () => {
    const self = rider({ riderId: 'self' });
    const root = render({ riders: [self] });
    expect(markerFor(root, 'self')).toBeTruthy();
  });
});

describe('OfflineRiderMap: self-location marker', () => {
  it('renders no self marker when selfLocation is not given', () => {
    const root = render({ selfLocation: null });
    expect(root.findAll(node => node.props.id === 'self' && node.props.lngLat !== undefined)).toHaveLength(0);
  });

  it('places a "You" marker at the given selfLocation', () => {
    const root = render({ selfLocation: { latitude: 17.4, longitude: 78.5 } });
    const marker = markerFor(root, 'self');
    expect(marker.props.lngLat).toEqual([78.5, 17.4]);
    expect(textsIn(marker)).toEqual(['You']);
  });
});

describe('OfflineRiderMap: destination', () => {
  it('renders no destination marker when none is given', () => {
    const root = render({ destination: null });
    expect(markerFor(root, 'destination')).toBeUndefined();
  });

  it('renders a destination marker at the destination\'s coordinates', () => {
    const root = render({ destination: { name: 'Beach House', latitude: 17.5, longitude: 78.6 } });
    expect(markerFor(root, 'destination').props.lngLat).toEqual([78.6, 17.5]);
  });

  it('labels the destination marker with its name', () => {
    const root = render({ destination: { name: 'Beach House', latitude: 17.5, longitude: 78.6 } });
    expect(textsIn(markerFor(root, 'destination')).some(t => t.includes('Beach House'))).toBe(true);
  });

  it('falls back to "Destination" when the destination has no name', () => {
    const root = render({ destination: { name: null, latitude: 17.5, longitude: 78.6 } });
    expect(textsIn(markerFor(root, 'destination')).some(t => t.includes('Destination'))).toBe(true);
  });
});

describe('OfflineRiderMap: route line (persists the active destination offline)', () => {
  it('draws no route when there is no destination', () => {
    const root = render({ selfLocation: { latitude: 17.4, longitude: 78.5 }, destination: null });
    expect(geoJsonSource(root, 'offlineRoute')).toBeUndefined();
  });

  it('draws no straight-line fallback without a self location', () => {
    const root = render({ selfLocation: null, destination: { name: null, latitude: 17.5, longitude: 78.6 } });
    expect(geoJsonSource(root, 'offlineRoute')).toBeUndefined();
  });

  it('falls back to a straight line from selfLocation to destination when no road route is given', () => {
    const root = render({
      selfLocation: { latitude: 17.4, longitude: 78.5 },
      destination: { name: null, latitude: 17.5, longitude: 78.6 },
    });
    const data = geoJsonSource(root, 'offlineRoute').props.data;
    expect(data.geometry.coordinates).toEqual([
      [78.5, 17.4],
      [78.6, 17.5],
    ]);
  });

  it('prefers a cached road-route geometry over the straight-line fallback when given', () => {
    const roadRoute: GeoJSON.LineString = {
      type: 'LineString',
      coordinates: [
        [78.5, 17.4],
        [78.55, 17.45],
        [78.6, 17.5],
      ],
    };
    const root = render({
      selfLocation: { latitude: 17.4, longitude: 78.5 },
      destination: { name: null, latitude: 17.5, longitude: 78.6 },
      routeGeometry: roadRoute,
    });
    expect(geoJsonSource(root, 'offlineRoute').props.data.geometry.coordinates).toHaveLength(3);
  });
});

describe('OfflineRiderMap: off-route detection', () => {
  const ROAD_ROUTE: GeoJSON.LineString = {
    type: 'LineString',
    coordinates: [
      [78.5, 17.4],
      [78.6, 17.5],
    ],
  };
  const ON_ROUTE = { latitude: 17.4, longitude: 78.5 };
  const FAR_OFF_ROUTE = { latitude: 17.5, longitude: 78.4 }; // well over 40m from ROAD_ROUTE

  function renderWithRoute(selfLocation: { latitude: number; longitude: number }, onOffRouteChange = jest.fn()) {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <OfflineRiderMap
          riders={[]}
          mapStyleUrl="https://example.com/style.json"
          selfLocation={selfLocation}
          destination={{ name: null, latitude: 17.5, longitude: 78.6 }}
          routeGeometry={ROAD_ROUTE}
          onOffRouteChange={onOffRouteChange}
        />,
      );
    });
    return { renderer, onOffRouteChange };
  }

  it('does not fire on a single off-route fix (debounced)', () => {
    const { onOffRouteChange } = renderWithRoute(FAR_OFF_ROUTE);
    expect(onOffRouteChange).not.toHaveBeenCalled();
  });

  it('fires with true after a second consecutive off-route fix, and renders rejoin guidance', () => {
    const { renderer, onOffRouteChange } = renderWithRoute(FAR_OFF_ROUTE);
    ReactTestRenderer.act(() => {
      renderer.update(
        <OfflineRiderMap
          riders={[]}
          mapStyleUrl="https://example.com/style.json"
          selfLocation={{ ...FAR_OFF_ROUTE, latitude: FAR_OFF_ROUTE.latitude + 0.00001 }}
          destination={{ name: null, latitude: 17.5, longitude: 78.6 }}
          routeGeometry={ROAD_ROUTE}
          onOffRouteChange={onOffRouteChange}
        />,
      );
    });
    expect(onOffRouteChange).toHaveBeenCalledWith(true);
    expect(onOffRouteChange).toHaveBeenCalledTimes(1); // only on the transition, not every fix
    expect(geoJsonSource(renderer.root, 'offlineRejoinGuidance')).toBeTruthy();
  });

  it('never fires against the straight-line fallback -- only a real cached route', () => {
    const onOffRouteChange = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <OfflineRiderMap
          riders={[]}
          mapStyleUrl="https://example.com/style.json"
          selfLocation={FAR_OFF_ROUTE}
          destination={{ name: null, latitude: 17.5, longitude: 78.6 }}
          onOffRouteChange={onOffRouteChange}
        />,
      );
    });
    ReactTestRenderer.act(() => {
      renderer.update(
        <OfflineRiderMap
          riders={[]}
          mapStyleUrl="https://example.com/style.json"
          selfLocation={{ ...FAR_OFF_ROUTE, latitude: FAR_OFF_ROUTE.latitude + 0.00001 }}
          destination={{ name: null, latitude: 17.5, longitude: 78.6 }}
          onOffRouteChange={onOffRouteChange}
        />,
      );
    });
    expect(onOffRouteChange).not.toHaveBeenCalled();
    expect(geoJsonSource(renderer.root, 'offlineRejoinGuidance')).toBeUndefined();
  });

  it('no rejoin guidance while on-route', () => {
    const { renderer } = renderWithRoute(ON_ROUTE);
    expect(geoJsonSource(renderer.root, 'offlineRejoinGuidance')).toBeUndefined();
  });
});

describe('OfflineRiderMap: map setup', () => {
  it('passes the given style URL through to the map', () => {
    const root = render({ mapStyleUrl: 'https://example.com/offline-style.json' });
    const map = root.findAll(node => node.props.mapStyle === 'https://example.com/offline-style.json');
    expect(map.length).toBeGreaterThan(0);
  });

  it('does not throw when no initial centre is given', () => {
    expect(() => render({ initialCenter: undefined })).not.toThrow();
  });
});
