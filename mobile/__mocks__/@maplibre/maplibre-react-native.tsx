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

// A harmless stub for anything that merely imports OfflineManager incidentally (e.g. a screen
// that also pulls in offlineMapManager.ts) without exercising it. A test that actually needs
// specific OfflineManager behaviour supplies its own richer mock -- see offlineMapManager.test.ts.
export const OfflineManager = {
  createPack: jest.fn(async () => ({ id: 'mock-pack', metadata: {}, status: jest.fn(), pause: jest.fn(), resume: jest.fn() })),
  getPacks: jest.fn(async () => []),
  getPack: jest.fn(async () => { throw new Error('not found'); }),
  deletePack: jest.fn(async () => {}),
  invalidatePack: jest.fn(async () => {}),
};
