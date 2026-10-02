import {
  HAZARD_THROTTLE_MS,
  createHazardPolicy,
} from '../src/protocol/hazardPolicy';
import {
  HAZARD_PACKET_MAX_AGE_MS,
  createHazardPacket,
  type HazardPacket,
  type HazardType,
} from '../src/protocol/hazardProtocol';

const NOW = 1_700_000_000_000;
const LOCAL_SENDER_ID = 'local';

function makePacket(
  id: string,
  hazard: HazardType = 'pothole',
  senderId: string = 'remote',
): HazardPacket {
  return {
    ...createHazardPacket(hazard, senderId, 'Alex', NOW),
    id,
  };
}

function setup() {
  let now = NOW;
  const policy = createHazardPolicy(LOCAL_SENDER_ID, () => now);
  return {
    policy,
    advanceTo(next: number) {
      now = next;
    },
  };
}

describe('hazard policy', () => {
  describe('local send', () => {
    test('accepts the first hazard, sends Nearby and sends LiveKit only when online', () => {
      const online = setup().policy.decideLocalSend(makePacket('local-online'), true);
      const offline = setup().policy.decideLocalSend(makePacket('local-offline'), false);

      expect(online).toEqual({
        accepted: true,
        shouldAnnounce: false,
        sendNearby: true,
        sendLiveKit: true,
      });
      expect(offline).toEqual({
        accepted: true,
        shouldAnnounce: false,
        sendNearby: true,
        sendLiveKit: false,
      });
    });

    test('suppresses the same locally sent type within four seconds', () => {
      const { policy, advanceTo } = setup();
      expect(policy.decideLocalSend(makePacket('first'), true).accepted).toBe(true);

      advanceTo(NOW + HAZARD_THROTTLE_MS - 1);
      expect(policy.decideLocalSend(makePacket('second'), true)).toEqual({
        accepted: false,
        shouldAnnounce: false,
        sendNearby: false,
        sendLiveKit: false,
        reason: 'recently_sent_type',
      });
    });

    test('accepts the same locally sent type at the exact four-second boundary', () => {
      const { policy, advanceTo } = setup();
      policy.decideLocalSend(makePacket('first'), true);
      advanceTo(NOW + HAZARD_THROTTLE_MS);

      expect(policy.decideLocalSend(makePacket('second'), true).accepted).toBe(true);
    });

    test('registers a packet ID before local type suppression', () => {
      const { policy, advanceTo } = setup();
      policy.decideLocalSend(makePacket('first'), true);
      advanceTo(NOW + 1);
      const suppressed = makePacket('suppressed-id', 'pothole', 'not-the-local-sender');

      expect(policy.decideLocalSend(suppressed, true).accepted).toBe(false);
      advanceTo(NOW + HAZARD_THROTTLE_MS);
      expect(policy.decideIncoming(suppressed, 'livekit', true)).toMatchObject({
        accepted: false,
        reason: 'duplicate_id',
      });
    });

    test('a recently received type suppresses a local send, but a recent local send does not suppress ingress', () => {
      const receivedFirst = setup();
      receivedFirst.policy.decideIncoming(makePacket('remote-first'), 'livekit', true);
      receivedFirst.advanceTo(NOW + 1);
      expect(receivedFirst.policy.decideLocalSend(makePacket('local-after-receive'), true)).toMatchObject({
        accepted: false,
        reason: 'recently_received_type',
      });

      const sentFirst = setup();
      sentFirst.policy.decideLocalSend(makePacket('local-first'), true);
      sentFirst.advanceTo(NOW + 1);
      expect(sentFirst.policy.decideIncoming(makePacket('remote-after-send'), 'livekit', true).accepted).toBe(
        true,
      );
    });
  });

  describe('LiveKit ingress', () => {
    test('accepts the first packet, announces it, relays Nearby and not LiveKit', () => {
      expect(setup().policy.decideIncoming(makePacket('livekit-first'), 'livekit', true)).toEqual({
        accepted: true,
        shouldAnnounce: true,
        relayNearby: true,
        relayLiveKit: false,
      });
    });

    test('rejects a local sender bounce before registering its ID', () => {
      const { policy } = setup();
      const localBounce = makePacket('bounce-id', 'pothole', LOCAL_SENDER_ID);

      expect(policy.decideIncoming(localBounce, 'livekit', true)).toMatchObject({
        accepted: false,
        reason: 'local_sender',
      });
      expect(
        policy.decideIncoming({ ...localBounce, senderId: 'remote' }, 'livekit', true).accepted,
      ).toBe(true);
    });

    test('rejects a duplicate packet ID', () => {
      const { policy } = setup();
      const packet = makePacket('duplicate');
      policy.decideIncoming(packet, 'livekit', true);

      expect(policy.decideIncoming(packet, 'livekit', true)).toMatchObject({
        accepted: false,
        reason: 'duplicate_id',
      });
    });

    test('rejects a distinct packet with the same hazard type inside four seconds', () => {
      const { policy, advanceTo } = setup();
      policy.decideIncoming(makePacket('first'), 'livekit', true);
      advanceTo(NOW + HAZARD_THROTTLE_MS - 1);

      expect(policy.decideIncoming(makePacket('second'), 'livekit', true)).toMatchObject({
        accepted: false,
        reason: 'recently_received_type',
      });
    });
  });

  describe('Nearby ingress', () => {
    test('accepts, announces and relays to both transports when online', () => {
      expect(setup().policy.decideIncoming(makePacket('nearby-online'), 'nearby', true)).toEqual({
        accepted: true,
        shouldAnnounce: true,
        relayNearby: true,
        relayLiveKit: true,
      });
    });

    test('relays Nearby but not LiveKit when offline', () => {
      expect(setup().policy.decideIncoming(makePacket('nearby-offline'), 'nearby', false)).toEqual({
        accepted: true,
        shouldAnnounce: true,
        relayNearby: true,
        relayLiveKit: false,
      });
    });

    test('rejects a duplicate packet ID', () => {
      const { policy } = setup();
      const packet = makePacket('nearby-duplicate');
      policy.decideIncoming(packet, 'nearby', true);

      expect(policy.decideIncoming(packet, 'nearby', true)).toMatchObject({
        accepted: false,
        reason: 'duplicate_id',
      });
    });
  });

  describe('spoken dedupe', () => {
    test('allows the first announcement and suppresses a duplicate', () => {
      const { policy } = setup();
      expect(policy.claimAnnouncement('spoken-id')).toBe(true);
      expect(policy.claimAnnouncement('spoken-id')).toBe(false);
    });

    test('keeps the exact 30-second boundary suppressed and allows it one millisecond later', () => {
      const { policy, advanceTo } = setup();
      policy.claimAnnouncement('spoken-id');

      advanceTo(NOW + HAZARD_PACKET_MAX_AGE_MS);
      expect(policy.claimAnnouncement('spoken-id')).toBe(false);
      advanceTo(NOW + HAZARD_PACKET_MAX_AGE_MS + 1);
      expect(policy.claimAnnouncement('spoken-id')).toBe(true);
    });
  });
});
