import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import { brand, font } from '../homeTheme';

interface BrakeFlasherProps {
  visible: boolean;
}

export default function BrakeFlasher({ visible }: BrakeFlasherProps) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.25,
          duration: 180,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pulse]);

  if (!visible) {
    return null;
  }
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.frame, { opacity: pulse }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      accessibilityLabel="Rider ahead braking hard"
    >
      <Text style={styles.label}>BRAKE</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: 14,
    borderColor: brand.danger,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 80,
  },
  label: {
    color: '#fff',
    backgroundColor: brand.danger,
    fontFamily: font.bold,
    fontSize: 40,
    letterSpacing: 4,
    paddingHorizontal: 24,
    paddingVertical: 6,
    borderRadius: 10,
    overflow: 'hidden',
  },
});
