import { Router, type RequestHandler } from 'express';
import type { PrismaClient, Room } from '@prisma/client';
import { isRoomCode } from '../auth/roomCode';
import { NAME_MAX_LENGTH } from '../auth/validation';
import type { Env } from '../config/env';
import { parseDestination } from '../rooms/destination';
import { createLiveKitToken } from '../services/livekitService';
import { createOrReuseHostedRoom, findRoomForJoin, updateRoomDestination } from '../services/roomService';

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

      const result = await createOrReuseHostedRoom(prisma, {
        userId: user.id,
        roomCode: user.roomCode,
        riderName,
        destination,
      });
      if (result.kind === 'ownership_conflict') {
        // Room codes only ever come from riders' own codes, so this shouldn't happen -- but hosting
        // another rider's room must be impossible, not merely unlikely.
        return res.status(409).json({ message: 'That room code is already in use.' });
      }
      const { room } = result;

      return res.status(201).json({
        roomCode: room.code,
        roomId: room.id,
        isHost: true,
        token: await createLiveKitToken(env.livekit, room.code, riderName, user.id, true),
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
      const code = typeof roomCode === 'string' ? roomCode.trim().toUpperCase() : '';
      if (!isRoomCode(code)) {
        return res.status(400).json({ message: 'Invalid room code.' });
      }

      const user = req.user!;
      const result = await findRoomForJoin(prisma, code, user.id);
      if (!result) {
        return res.status(404).json({ message: 'Ride room not found. Check the 5-digit code.' });
      }

      const { room, isHost } = result;
      const riderName = displayName(req.body?.riderName, user.name);

      return res.status(200).json({
        roomCode: room.code,
        roomId: room.id,
        isHost,
        token: await createLiveKitToken(env.livekit, room.code, riderName, user.id, isHost),
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
      if (!isRoomCode(code)) {
        return res.status(400).json({ message: 'Invalid room code.' });
      }

      const destination = parseDestination(req.body);
      if (!destination) {
        return res.status(400).json({ message: 'A valid destination is required.' });
      }

      const result = await updateRoomDestination(prisma, code, req.user!.id, destination);
      if (result.kind === 'not_found') {
        return res.status(404).json({ message: 'Ride room not found.' });
      }
      if (result.kind === 'forbidden') {
        return res.status(403).json({ message: 'Only the ride creator can change the destination.' });
      }

      return res.status(200).json(destinationFields(result.room));
    } catch (error) {
      console.error('Update destination error:', error);
      return res.status(500).json({ message: 'Failed to update destination.' });
    }
  });

  return router;
}
