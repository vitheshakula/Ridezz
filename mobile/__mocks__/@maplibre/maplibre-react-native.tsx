import React from 'react';
import { View } from 'react-native';

const Component = React.forwardRef<any, any>(({ children, ...props }, ref) => (
  <View ref={ref} {...props}>
    {children}
  </View>
));

export const Map = Component;

export const Camera = React.forwardRef<any, any>(({ children, ...props }, ref) => {
  React.useImperativeHandle(ref, () => ({
    easeTo: jest.fn(),
    zoomTo: jest.fn(),
    fitBounds: jest.fn(),
    flyTo: jest.fn(),
    setCamera: jest.fn(),
  }));
  return <View {...props}>{children}</View>;
});

export const GeoJSONSource = Component;
export const Layer = Component;
export const Marker = Component;

export const OfflineManager = {
  createPack: jest.fn(async () => ({ id: 'mock-pack', metadata: {}, status: jest.fn(), pause: jest.fn(), resume: jest.fn() })),
  getPacks: jest.fn(async () => []),
  getPack: jest.fn(async () => { throw new Error('not found'); }),
  deletePack: jest.fn(async () => {}),
  invalidatePack: jest.fn(async () => {}),
};
