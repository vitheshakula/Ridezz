import React from 'react';
import { Image, StyleSheet } from 'react-native';

interface LogoProps {
  size?: number;
}

export function Logo({ size = 36 }: LogoProps) {
  return (
    <Image
      source={require('../assets/rideaze-logo.png')}
      style={[styles.logo, { width: size, height: size }]}
      resizeMode="contain"
      accessibilityLabel="Rideaze logo"
    />
  );
}

const styles = StyleSheet.create({
  logo: {},
});
