import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient, type User } from '@prisma/client';

export const ROOM_CODE_MIN = 10000;
export const ROOM_CODE_MAX = 99999;

const MAX_ATTEMPTS = 25;

export type RandomInt = (min: number, max: number) => number;

export class RoomCodeUnavailableError extends Error {
  constructor() {
    super('Could not allocate a free room code.');
    this.name = 'RoomCodeUnavailableError';
  }
}

export function generateRoomCode(random: RandomInt = randomInt): string {
  return String(random(ROOM_CODE_MIN, ROOM_CODE_MAX + 1));
}

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{4}$/.test(value);
}

function isRoomCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  return Array.isArray(target) && target.includes('roomCode');
}

export async function createUserWithRoomCode(
  prisma: PrismaClient,
  data: Omit<Prisma.UserCreateInput, 'roomCode'>,
  random: RandomInt = randomInt,
): Promise<User> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const roomCode = generateRoomCode(random);
    if (await prisma.user.findUnique({ where: { roomCode } })) {
      continue;
    }
    try {
      return await prisma.user.create({ data: { ...data, roomCode } });
    } catch (err) {
      if (isRoomCodeCollision(err)) {
        continue;
      }
      throw err;
    }
  }
  throw new RoomCodeUnavailableError();
}

export async function ensureRoomCode(
  prisma: PrismaClient,
  userId: string,
  random: RandomInt = randomInt,
): Promise<string> {
  const read = () => prisma.user.findUnique({ where: { id: userId }, select: { roomCode: true } });

  const current = await read();
  if (!current) {
    throw new Error('Account not found.');
  }
  if (current.roomCode) {
    return current.roomCode;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = generateRoomCode(random);
    if (await prisma.user.findUnique({ where: { roomCode: candidate } })) {
      continue;
    }
    try {
      const { count } = await prisma.user.updateMany({
        where: { id: userId, roomCode: null },
        data: { roomCode: candidate },
      });
      if (count === 1) {
        return candidate;
      }
      const winner = await read();
      if (winner?.roomCode) {
        return winner.roomCode;
      }
      throw new Error('Account not found.');
    } catch (err) {
      if (isRoomCodeCollision(err)) {
        continue;
      }
      throw err;
    }
  }
  throw new RoomCodeUnavailableError();
}

export async function withRoomCode(
  prisma: PrismaClient,
  user: User,
  random?: RandomInt,
): Promise<User> {
  return user.roomCode
    ? user
    : { ...user, roomCode: await ensureRoomCode(prisma, user.id, random) };
}
