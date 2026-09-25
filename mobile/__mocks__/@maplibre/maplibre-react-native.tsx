import React from 'react';
import { View } from 'react-native';

const Component = React.forwardRef<any, any>(({ children, ...props }, ref) => (
  <View ref={ref} {...props}>
    {children}
  </View>
));

export const Map = Component;
export const Camera = Component;
export const GeoJSONSource = Component;
export const Layer = Component;
export const Marker = Component;
