import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient, type User } from '@prisma/client';

/**
 * A rider's permanent room code: five digits, 10000 to 99999, unique across accounts. It is issued
 * once and never changes; when the rider hosts a ride it is the ride's code, so the group always
 * knows where to find them.
 *
 * Every rider needs one, but accounts made before this existed don't have one yet. They are given
 * theirs lazily -- the next time they sign in, fetch their profile, or host -- by `ensureRoomCode`.
 */
export const ROOM_CODE_MIN = 10000;
export const ROOM_CODE_MAX = 99999;

/** Only reachable if the code space is nearly exhausted; keeps a pathological case from spinning. */
const MAX_ATTEMPTS = 25;

/** `crypto.randomInt`'s shape. Injectable so tests can force a collision. */
export type RandomInt = (min: number, max: number) => number;

export class RoomCodeUnavailableError extends Error {
  constructor() {
    super('Could not allocate a free room code.');
    this.name = 'RoomCodeUnavailableError';
  }
}

/** One random candidate, uniform over the whole range. It is not yet known to be free. */
export function generateRoomCode(random: RandomInt = randomInt): string {
  // randomInt's upper bound is exclusive.
  return String(random(ROOM_CODE_MIN, ROOM_CODE_MAX + 1));
}

/** True for exactly the strings "10000" to "99999". */
export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{4}$/.test(value);
}

/** A unique-constraint failure caused by the room code, as opposed to e.g. a duplicate email. */
function isRoomCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  return Array.isArray(target) && target.includes('roomCode');
}

/**
 * Creates an account with a newly allocated room code.
 *
 * Each candidate is checked against the database before it is used, and if two sign-ups still race
 * to the same one, the database's unique index rejects the loser and it simply draws again. Any
 * other failure -- notably a duplicate email -- is thrown untouched so the caller keeps handling it.
 */
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

/**
 * The rider's room code, allocating one first if they have never had it (an account from before
 * the feature). Safe to call repeatedly and concurrently: an existing code is never replaced, and
 * if two requests race to assign one, both come back with the same winner.
 */
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
      // Only fills an empty slot, so a concurrent request that got there first is never overwritten.
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

/** The same account, guaranteed to carry a room code. */
export async function withRoomCode(prisma: PrismaClient, user: User, random?: RandomInt): Promise<User> {
  return user.roomCode ? user : { ...user, roomCode: await ensureRoomCode(prisma, user.id, random) };
}
