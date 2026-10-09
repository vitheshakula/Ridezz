/**
 * Cloud reachability for the Ride Connectivity Protocol, as used by the app.
 *
 * Production behaviour: FALSE. No phone advertises itself as a gateway. There is no trustworthy
 * cloud-reachability signal yet (a connected LiveKit room is not one), so gateway status must
 * never be inferred.
 *
 * Device-testing overrides (both explicit, both per device, both default off):
 *   - FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST: build-time switch for a RELEASE test APK. Set it to
 *     true ONLY in the working copy used to build the single gateway phone's APK, then set it
 *     back. A unit test fails if it is ever committed as true.
 *   - Dev-menu toggle (debug builds only): "Rideaze: toggle test cloud gateway" in the React
 *     Native dev menu flips setDevMenuGatewayForced on that one phone; it resets on app restart.
 */

/** MUST stay false in committed code. */
export const FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST = false;

let devMenuForced = false;

export function setDevMenuGatewayForced(forced: boolean): void {
  devMenuForced = forced;
}

export function isDevMenuGatewayForced(): boolean {
  return devMenuForced;
}

/** What the runtime's isCloudReachable uses: false unless a device-test override is active. */
export function isRideCloudReachable(): boolean {
  return FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST || devMenuForced;
}
