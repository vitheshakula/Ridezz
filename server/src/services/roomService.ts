import type { PrismaClient, Room } from '@prisma/client';
import { ensureRoomCode } from '../auth/roomCode';
import type { Destination } from '../rooms/destination';

interface CreateHostedRoomInput {
  userId: string;
  roomCode: string | null;
  riderName: string;
  destination: Destination | null;
}

export type CreateHostedRoomResult =
  | { kind: 'ok'; room: Room }
  | { kind: 'ownership_conflict' };

/** Creates the signed-in rider's room, or refreshes that same room for a new ride. */
export async function createOrReuseHostedRoom(
  prisma: PrismaClient,
  { userId, roomCode, riderName, destination }: CreateHostedRoomInput,
): Promise<CreateHostedRoomResult> {
  const code = roomCode ?? (await ensureRoomCode(prisma, userId));
  const existing = await prisma.room.findUnique({ where: { code } });
  if (existing && existing.hostId !== userId) {
    return { kind: 'ownership_conflict' };
  }

  const fields = {
    name: `${riderName}'s Ride`,
    destinationName: destination?.name ?? null,
    destinationLat: destination?.lat ?? null,
    destinationLng: destination?.lng ?? null,
  };
  const room = await prisma.room.upsert({
    where: { code },
    create: { code, hostId: userId, ...fields },
    update: fields,
  });
  return { kind: 'ok', room };
}

export interface RoomForJoin {
  room: Room;
  isHost: boolean;
}

/** Finds a room and determines whether the joining rider owns it. */
export async function findRoomForJoin(
  prisma: PrismaClient,
  roomCode: string,
  userId: string,
): Promise<RoomForJoin | null> {
  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  return room ? { room, isHost: room.hostId === userId } : null;
}

export type UpdateRoomDestinationResult =
  | { kind: 'ok'; room: Room }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/** Updates a room's destination only when the requesting rider is its host. */
export async function updateRoomDestination(
  prisma: PrismaClient,
  roomCode: string,
  userId: string,
  destination: Destination,
): Promise<UpdateRoomDestinationResult> {
  const room = await prisma.room.findUnique({ where: { code: roomCode } });
  if (!room) {
    return { kind: 'not_found' };
  }
  if (room.hostId !== userId) {
    return { kind: 'forbidden' };
  }

  const updated = await prisma.room.update({
    where: { code: roomCode },
    data: {
      destinationName: destination.name,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
    },
  });
  return { kind: 'ok', room: updated };
}
