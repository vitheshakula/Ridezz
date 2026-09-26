import { Router, type RequestHandler } from 'express';
import type { PrismaClient, Room } from '@prisma/client';
import { AccessToken } from 'livekit-server-sdk';
import { ensureRoomCode } from '../auth/roomCode';
import { NAME_MAX_LENGTH } from '../auth/validation';
import type { Env } from '../config/env';
import { parseDestination } from '../rooms/destination';

interface RoomsRouterDeps {
  prisma: PrismaClient;
  env: Env;
  requireAuth: RequestHandler;
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

  // Starts a ride hosted by the signed-in rider, optionally with a destination, and returns a token
  // to join it. A missing or out-of-range destination just means "no destination".
  //
  // The room's code is the host's permanent 5-digit room code -- nothing random is generated. A
  // rider therefore hosts the same room every time, so hosting again reuses it (with the new
  // destination, or none) rather than creating another.
  router.post('/create', async (req, res) => {
    try {
      const user = req.user!;
      const riderName = displayName(req.body?.riderName, user.name);
      const destination = parseDestination(req.body);

      // Accounts from before room codes existed get theirs the first time they host.
      const code = user.roomCode ?? (await ensureRoomCode(prisma, user.id));

      const existing = await prisma.room.findUnique({ where: { code } });
      if (existing && existing.hostId !== user.id) {
        // Room codes only ever come from riders' own codes, so this shouldn't happen -- but hosting
        // another rider's room must be impossible, not merely unlikely.
        return res.status(409).json({ message: 'That room code is already in use.' });
      }

      const fields = {
        name: `${riderName}'s Ride`,
        destinationName: destination?.name ?? null,
        destinationLat: destination?.lat ?? null,
        destinationLng: destination?.lng ?? null,
      };
      const room = await prisma.room.upsert({
        where: { code },
        create: { code, hostId: user.id, ...fields },
        update: fields,
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

  // Validates a room code (a host's 5-digit code) and returns a token to join that room.
  router.post('/join', async (req, res) => {
    try {
      const { roomCode } = req.body ?? {};
      if (typeof roomCode !== 'string' || !roomCode.trim()) {
        return res.status(400).json({ message: 'Room code is required.' });
      }

      const room = await prisma.room.findUnique({ where: { code: roomCode.trim().toUpperCase() } });
      if (!room) {
        return res.status(404).json({ message: 'Ride room not found. Check the 5-digit code.' });
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
