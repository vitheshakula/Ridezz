// Manual Jest mock for react-native-maps.
//
// The real package ships raw TS and touches the native Google Maps view, which
// doesn't exist under Jest. Our code only uses MapView/Marker/Callout (see
// RiderMap.tsx), so this mock stubs exactly that slice.
import type { PropsWithChildren } from 'react';
import { View } from 'react-native';

export function Marker({ children }: PropsWithChildren<Record<string, unknown>>) {
  return <View>{children}</View>;
}

export function Callout({ children }: PropsWithChildren<Record<string, unknown>>) {
  return <View>{children}</View>;
}

export default function MapView({ children }: PropsWithChildren<Record<string, unknown>>) {
  return <View>{children}</View>;
}
