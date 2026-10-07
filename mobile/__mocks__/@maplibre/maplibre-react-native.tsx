import React from 'react';
import { View } from 'react-native';

const Component = React.forwardRef<any, any>(({ children, ...props }, ref) => (
  <View ref={ref} {...props}>
    {children}
  </View>
));

export const Map = Component;

// Camera's real ref exposes imperative methods (easeTo/zoomTo/fitBounds/...), not a View --
// components that drive the camera (RiderMap, OfflineRiderMap) call these directly off
// cameraRef.current. Exposed as jest.fn() stubs via useImperativeHandle so that code can run
// under test without crashing, and so a test can assert a call was made if it wants to.
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
