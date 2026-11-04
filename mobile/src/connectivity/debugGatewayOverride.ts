export const FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST = false;

let devMenuForced = false;

export function setDevMenuGatewayForced(forced: boolean): void {
  devMenuForced = forced;
}

export function isDevMenuGatewayForced(): boolean {
  return devMenuForced;
}

export function isRideCloudReachable(): boolean {
  return FORCE_CLOUD_GATEWAY_FOR_DEVICE_TEST || devMenuForced;
}
