import { randomInt } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { AccessToken } from 'livekit-server-sdk';
import { NAME_MAX_LENGTH } from '../auth/validation';
import type { Env } from '../config/env';

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

export function createRoomsRouter({ prisma, env, requireAuth }: RoomsRouterDeps): Router {
  const router = Router();

  // Every room route needs a signed-in rider: it hands out a LiveKit token that can publish audio.
  router.use(requireAuth);

  async function createLiveKitToken(roomCode: string, riderName: string, identity: string) {
    const at = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
      identity,
      name: riderName,
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

  // Creates a room hosted by the signed-in rider and returns a token to join it.
  router.post('/create', async (req, res) => {
    try {
      const user = req.user!;
      const riderName = displayName(req.body?.riderName, user.name);

      let code = generateRoomCode();
      while (await prisma.room.findUnique({ where: { code } })) {
        code = generateRoomCode();
      }

      const room = await prisma.room.create({
        data: { code, name: `${riderName}'s Ride`, hostId: user.id },
      });

      const identity = `${riderName}_${Date.now()}`;
      const token = await createLiveKitToken(room.code, riderName, identity);

      return res.status(201).json({
        roomCode: room.code,
        roomId: room.id,
        token,
        serverUrl: env.livekit.url,
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

      const riderName = displayName(req.body?.riderName, req.user!.name);
      const identity = `${riderName}_${Date.now()}`;
      const token = await createLiveKitToken(room.code, riderName, identity);

      return res.status(200).json({
        roomCode: room.code,
        roomId: room.id,
        token,
        serverUrl: env.livekit.url,
      });
    } catch (error) {
      console.error('Join room error:', error);
      return res.status(500).json({ message: 'Failed to join room.' });
    }
  });

  return router;
}
