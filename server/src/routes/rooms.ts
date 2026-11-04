import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { PrismaClient, Room } from '@prisma/client';
import { isRoomCode } from '../auth/roomCode';
import { NAME_MAX_LENGTH } from '../auth/validation';
import type { Env } from '../config/env';
import { ErrorCode, sendError } from '../errors';
import { logRequestError } from '../http';
import { logger } from '../logger';
import { parseDestination } from '../rooms/destination';
import { createLiveKitToken } from '../services/livekitService';
import {
  createOrReuseHostedRoom,
  findRoomForJoin,
  updateRoomDestination,
} from '../services/roomService';

interface RoomsRouterDeps {
  prisma: PrismaClient;
  env: Env;
  requireAuth: RequestHandler;
}

type RoomHandler = (req: Request, res: Response) => Promise<unknown>;

function displayName(requested: unknown, fallback: string): string {
  const trimmed = typeof requested === 'string' ? requested.trim().slice(0, NAME_MAX_LENGTH) : '';
  return trimmed || fallback;
}

function normalizeRoomCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

function destinationFields(
  room: Pick<Room, 'destinationName' | 'destinationLat' | 'destinationLng'>,
) {
  return {
    destinationName: room.destinationName,
    destinationLat: room.destinationLat,
    destinationLng: room.destinationLng,
  };
}

function withFailureMessage(event: string, message: string, handler: RoomHandler): RequestHandler {
  return (req, res) => {
    handler(req, res).catch(error => {
      logRequestError(req, event, error);
      if (!res.headersSent) {
        sendError(res, 500, ErrorCode.InternalError, message);
      }
    });
  };
}

export function createRoomsRouter({ prisma, env, requireAuth }: RoomsRouterDeps): Router {
  const router = Router();

  const roomAccess = async (room: Room, riderName: string, userId: string, isHost: boolean) => ({
    roomCode: room.code,
    roomId: room.id,
    isHost,
    token: await createLiveKitToken(env.livekit, room.code, riderName, userId, isHost),
    serverUrl: env.livekit.url,
    ...destinationFields(room),
  });

  router.use(requireAuth);

  router.post(
    '/create',
    withFailureMessage('room_create_error', 'Failed to create room.', async (req, res) => {
      const user = req.user!;
      const riderName = displayName(req.body?.riderName, user.name);
      const result = await createOrReuseHostedRoom(prisma, {
        userId: user.id,
        roomCode: user.roomCode,
        riderName,
        destination: parseDestination(req.body),
      });
      if (result.kind === 'ownership_conflict') {
        return sendError(res, 409, ErrorCode.RoomCodeConflict, 'That room code is already in use.');
      }
      logger().info('room_hosted', {
        requestId: req.requestId,
        userId: user.id,
        roomCode: result.room.code,
      });
      return res.status(201).json(await roomAccess(result.room, riderName, user.id, true));
    }),
  );

  router.post(
    '/join',
    withFailureMessage('room_join_error', 'Failed to join room.', async (req, res) => {
      const code = normalizeRoomCode(req.body?.roomCode);
      if (!isRoomCode(code)) {
        return sendError(res, 400, ErrorCode.ValidationFailed, 'Invalid room code.');
      }

      const user = req.user!;
      const result = await findRoomForJoin(prisma, code, user.id);
      if (!result) {
        return sendError(
          res,
          404,
          ErrorCode.RoomNotFound,
          'Ride room not found. Check the 5-digit code.',
        );
      }

      const riderName = displayName(req.body?.riderName, user.name);
      logger().info('room_joined', {
        requestId: req.requestId,
        userId: user.id,
        roomCode: result.room.code,
        isHost: result.isHost,
      });
      return res.status(200).json(await roomAccess(result.room, riderName, user.id, result.isHost));
    }),
  );

  router.patch(
    '/:roomCode/destination',
    withFailureMessage(
      'room_destination_error',
      'Failed to update destination.',
      async (req, res) => {
        const code = normalizeRoomCode(req.params.roomCode);
        if (!isRoomCode(code)) {
          return sendError(res, 400, ErrorCode.ValidationFailed, 'Invalid room code.');
        }

        const destination = parseDestination(req.body);
        if (!destination) {
          return sendError(
            res,
            400,
            ErrorCode.ValidationFailed,
            'A valid destination is required.',
          );
        }

        const result = await updateRoomDestination(prisma, code, req.user!.id, destination);
        if (result.kind === 'not_found') {
          return sendError(res, 404, ErrorCode.RoomNotFound, 'Ride room not found.');
        }
        if (result.kind === 'forbidden') {
          return sendError(
            res,
            403,
            ErrorCode.Forbidden,
            'Only the ride creator can change the destination.',
          );
        }

        logger().info('room_destination_updated', {
          requestId: req.requestId,
          userId: req.user!.id,
          roomCode: code,
        });
        return res.status(200).json(destinationFields(result.room));
      },
    ),
  );

  return router;
}
