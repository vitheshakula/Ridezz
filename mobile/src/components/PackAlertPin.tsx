import { StyleSheet, Text, View } from 'react-native';
import { Marker } from '@maplibre/maplibre-react-native';
import { brand, font } from '../homeTheme';
import type { PackAlert } from '../convoy/packAlerts';

const TONE = {
  BREAKDOWN: brand.danger,
  SEPARATION: brand.warning,
  LOST_CONTACT: brand.outline,
} as const;

const TAG = {
  BREAKDOWN: 'STOPPED',
  SEPARATION: 'AWAY',
  LOST_CONTACT: 'LAST SEEN',
} as const;

/** Map pin for a convoy alert at the affected rider's last known position. */
export function PackAlertPin({ alert }: { alert: PackAlert }) {
  const tone = TONE[alert.eventType];
  return (
    <View
      style={styles.wrap}
      accessibilityLabel={`${alert.name || 'Rider'} ${TAG[alert.eventType]}`}
    >
      <View style={[styles.tag, { backgroundColor: tone }]}>
        <Text style={styles.tagText} numberOfLines={1}>
          {TAG[alert.eventType]}
          {alert.name ? ` · ${alert.name}` : ''}
        </Text>
      </View>
      <View style={[styles.dot, { borderColor: tone }]}>
        <Text style={[styles.bang, { color: tone }]}>!</Text>
      </View>
    </View>
  );
}

/** Pins for every alert that has a position; alerts without one (group silence) get none. */
export function renderPackAlertPins(alerts: readonly PackAlert[] | undefined) {
  return (alerts ?? [])
    .filter(a => a.lat !== null && a.lng !== null && !a.self)
    .map(a => (
      <Marker
        key={`pack-${a.key}`}
        id={`pack-${a.key}`}
        lngLat={[a.lng as number, a.lat as number]}
        anchor="bottom"
      >
        <PackAlertPin alert={a} />
      </Marker>
    ));
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  tag: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
    maxWidth: 160,
  },
  tagText: {
    fontFamily: font.bold,
    fontSize: 11,
    color: brand.darkest,
    letterSpacing: 0.4,
  },
  dot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
    backgroundColor: brand.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bang: { fontFamily: font.bold, fontSize: 16, lineHeight: 18 },
});
