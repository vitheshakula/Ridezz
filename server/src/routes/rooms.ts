import { randomInt } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { PrismaClient, Room } from '@prisma/client';
import { AccessToken } from 'livekit-server-sdk';
import { NAME_MAX_LENGTH } from '../auth/validation';
import type { Env } from '../config/env';
import { parseDestination } from '../rooms/destination';

interface RoomsRouterDeps {
  prisma: PrismaClient;
  env: Env;
  requireAuth: RequestHandler;
}

// Skips ambiguous 0/O and 1/I.
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 6-character room code. Uses a cryptographic RNG: the code is the only thing standing between a
 * stranger and a live voice channel, so it must not be predictable. */
function generateRoomCode(): string {
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += ROOM_CODE_CHARS.charAt(randomInt(ROOM_CODE_CHARS.length));
  }
  return result;
}

/** The name shown to the room: what the rider typed, else the name on their account. */
function displayName(requested: unknown, fallback: string): string {
  const trimmed = typeof requested === 'string' ? requested.trim().slice(0, NAME_MAX_LENGTH) : '';
  return trimmed || fallback;
}

/** The parts of a room every create/join/update response repeats. */
function destinationFields(room: Pick<Room, 'destinationName' | 'destinationLat' | 'destinationLng'>) {
  return {
    destinationName: room.destinationName,
    destinationLat: room.destinationLat,
    destinationLng: room.destinationLng,
  };
}

export function createRoomsRouter({ prisma, env, requireAuth }: RoomsRouterDeps): Router {
  const router = Router();

  // Every room route needs a signed-in rider: it hands out a LiveKit token that can publish audio.
  router.use(requireAuth);

  /** `identity` is the rider's account id plus a per-join suffix, so two riders with the same
   * display name never collide; `metadata` lets every client see who the host is. */
  async function createLiveKitToken(
    roomCode: string,
    riderName: string,
    userId: string,
    isHost: boolean,
  ) {
    const at = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
      identity: `${userId}_${Date.now()}`,
      name: riderName,
      metadata: JSON.stringify({ userId, isHost }),
      ttl: '6h',
    });
    at.addGrant({
      roomJoin: true,
      room: roomCode,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    });
    return at.toJwt();
  }

  // Creates a room hosted by the signed-in rider, optionally with a destination, and returns a
  // token to join it. A missing or out-of-range destination just means "no destination".
  router.post('/create', async (req, res) => {
    try {
      const user = req.user!;
      const riderName = displayName(req.body?.riderName, user.name);
      const destination = parseDestination(req.body);

      let code = generateRoomCode();
      while (await prisma.room.findUnique({ where: { code } })) {
        code = generateRoomCode();
      }

      const room = await prisma.room.create({
        data: {
          code,
          name: `${riderName}'s Ride`,
          hostId: user.id,
          destinationName: destination?.name ?? null,
          destinationLat: destination?.lat ?? null,
          destinationLng: destination?.lng ?? null,
        },
      });

      return res.status(201).json({
        roomCode: room.code,
        roomId: room.id,
        isHost: true,
        token: await createLiveKitToken(room.code, riderName, user.id, true),
        serverUrl: env.livekit.url,
        ...destinationFields(room),
      });
    } catch (error) {
      console.error('Create room error:', error);
      return res.status(500).json({ message: 'Failed to create room.' });
    }
  });

  // Validates a 6-character code and returns a token to join that room.
  router.post('/join', async (req, res) => {
    try {
      const { roomCode } = req.body ?? {};
      if (typeof roomCode !== 'string' || !roomCode.trim()) {
        return res.status(400).json({ message: 'Room code is required.' });
      }

      const room = await prisma.room.findUnique({ where: { code: roomCode.trim().toUpperCase() } });
      if (!room) {
        return res.status(404).json({ message: 'Ride room not found. Check the 6-character code.' });
      }

      const user = req.user!;
      const isHost = room.hostId === user.id;
      const riderName = displayName(req.body?.riderName, user.name);

      return res.status(200).json({
        roomCode: room.code,
        roomId: room.id,
        isHost,
        token: await createLiveKitToken(room.code, riderName, user.id, isHost),
        serverUrl: env.livekit.url,
        ...destinationFields(room),
      });
    } catch (error) {
      console.error('Join room error:', error);
      return res.status(500).json({ message: 'Failed to join room.' });
    }
  });

  // Changes where the ride is headed. Only the rider who created the room may do it.
  router.patch('/:roomCode/destination', async (req, res) => {
    try {
      const code = req.params.roomCode?.trim().toUpperCase();
      const destination = parseDestination(req.body);
      if (!code || !destination) {
        return res.status(400).json({ message: 'A valid destination is required.' });
      }

      const room = await prisma.room.findUnique({ where: { code } });
      if (!room) {
        return res.status(404).json({ message: 'Ride room not found.' });
      }
      if (room.hostId !== req.user!.id) {
        return res.status(403).json({ message: 'Only the ride creator can change the destination.' });
      }

      const updated = await prisma.room.update({
        where: { code },
        data: {
          destinationName: destination.name,
          destinationLat: destination.lat,
          destinationLng: destination.lng,
        },
      });
      return res.status(200).json(destinationFields(updated));
    } catch (error) {
      console.error('Update destination error:', error);
      return res.status(500).json({ message: 'Failed to update destination.' });
    }
  });

  return router;
}
