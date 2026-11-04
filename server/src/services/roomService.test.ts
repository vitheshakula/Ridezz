import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient, Room } from '@prisma/client';
import { createOrReuseHostedRoom, findRoomForJoin, updateRoomDestination } from './roomService';

const destination = { name: 'Golconda Fort', lat: 17.3833, lng: 78.4011 };

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-1',
    code: '54321',
    name: "Alex's Ride",
    hostId: 'host-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    destinationName: null,
    destinationLat: null,
    destinationLng: null,
    ...overrides,
  };
}

describe('createOrReuseHostedRoom', () => {
  it('creates a new host room and persists its destination', async () => {
    let findArgs: any;
    let upsertArgs: any;
    const created = room({
      destinationName: destination.name,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
    });
    const prisma = {
      room: {
        findUnique: async (args: any) => {
          findArgs = args;
          return null;
        },
        upsert: async (args: any) => {
          upsertArgs = args;
          return created;
        },
      },
    } as unknown as PrismaClient;

    const result = await createOrReuseHostedRoom(prisma, {
      userId: 'host-1',
      roomCode: '54321',
      riderName: 'Alex',
      destination,
    });

    assert.deepEqual(result, { kind: 'ok', room: created });
    assert.deepEqual(findArgs, { where: { code: '54321' } });
    assert.deepEqual(upsertArgs, {
      where: { code: '54321' },
      create: {
        code: '54321',
        hostId: 'host-1',
        name: "Alex's Ride",
        destinationName: destination.name,
        destinationLat: destination.lat,
        destinationLng: destination.lng,
      },
      update: {
        name: "Alex's Ride",
        destinationName: destination.name,
        destinationLat: destination.lat,
        destinationLng: destination.lng,
      },
    });
  });

  it('reuses a room owned by the same host and clears an omitted destination', async () => {
    const existing = room({
      destinationName: destination.name,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
    });
    const updated = room();
    let upsertArgs: any;
    const prisma = {
      room: {
        findUnique: async () => existing,
        upsert: async (args: any) => {
          upsertArgs = args;
          return updated;
        },
      },
    } as unknown as PrismaClient;

    const result = await createOrReuseHostedRoom(prisma, {
      userId: 'host-1',
      roomCode: '54321',
      riderName: 'Alex',
      destination: null,
    });

    assert.deepEqual(result, { kind: 'ok', room: updated });
    assert.deepEqual(upsertArgs.update, {
      name: "Alex's Ride",
      destinationName: null,
      destinationLat: null,
      destinationLng: null,
    });
  });

  it('reports an ownership conflict without changing the existing room', async () => {
    let upserted = false;
    const prisma = {
      room: {
        findUnique: async () => room({ hostId: 'another-host' }),
        upsert: async () => {
          upserted = true;
          return room();
        },
      },
    } as unknown as PrismaClient;

    const result = await createOrReuseHostedRoom(prisma, {
      userId: 'host-1',
      roomCode: '54321',
      riderName: 'Alex',
      destination: null,
    });

    assert.deepEqual(result, { kind: 'ownership_conflict' });
    assert.equal(upserted, false);
  });

  it('allocates a room code for an account that does not have one yet', async () => {
    let allocatedCode: string | undefined;
    const prisma = {
      user: {
        findUnique: async (args: any) => {
          if ('id' in args.where) {
            return { roomCode: null };
          }
          allocatedCode = args.where.roomCode;
          return null;
        },
        updateMany: async (args: any) => {
          assert.deepEqual(args.where, { id: 'host-1', roomCode: null });
          assert.equal(args.data.roomCode, allocatedCode);
          return { count: 1 };
        },
      },
      room: {
        findUnique: async (args: any) => {
          assert.equal(args.where.code, allocatedCode);
          return null;
        },
        upsert: async (args: any) => room({ code: args.create.code }),
      },
    } as unknown as PrismaClient;

    const result = await createOrReuseHostedRoom(prisma, {
      userId: 'host-1',
      roomCode: null,
      riderName: 'Alex',
      destination: null,
    });

    assert.match(allocatedCode ?? '', /^[1-9]\d{4}$/);
    assert.equal(result.kind, 'ok');
    assert.equal(result.kind === 'ok' ? result.room.code : null, allocatedCode);
  });
});

describe('findRoomForJoin', () => {
  it('returns the room and detects host and non-host riders', async () => {
    const found = room();
    const prisma = {
      room: { findUnique: async () => found },
    } as unknown as PrismaClient;

    assert.deepEqual(await findRoomForJoin(prisma, '54321', 'host-1'), {
      room: found,
      isHost: true,
    });
    assert.deepEqual(await findRoomForJoin(prisma, '54321', 'guest-1'), {
      room: found,
      isHost: false,
    });
  });

  it('returns null when the room does not exist', async () => {
    let findArgs: any;
    const prisma = {
      room: {
        findUnique: async (args: any) => {
          findArgs = args;
          return null;
        },
      },
    } as unknown as PrismaClient;

    assert.equal(await findRoomForJoin(prisma, '99999', 'guest-1'), null);
    assert.deepEqual(findArgs, { where: { code: '99999' } });
  });
});

describe('updateRoomDestination', () => {
  it('updates the destination for the room host', async () => {
    const updated = room({
      destinationName: destination.name,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
    });
    let updateArgs: any;
    const prisma = {
      room: {
        findUnique: async () => room(),
        update: async (args: any) => {
          updateArgs = args;
          return updated;
        },
      },
    } as unknown as PrismaClient;

    const result = await updateRoomDestination(prisma, '54321', 'host-1', destination);

    assert.deepEqual(result, { kind: 'ok', room: updated });
    assert.deepEqual(updateArgs, {
      where: { code: '54321' },
      data: {
        destinationName: destination.name,
        destinationLat: destination.lat,
        destinationLng: destination.lng,
      },
    });
  });

  it('reports not found without attempting an update', async () => {
    let updated = false;
    const prisma = {
      room: {
        findUnique: async () => null,
        update: async () => {
          updated = true;
          return room();
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await updateRoomDestination(prisma, '99999', 'host-1', destination), {
      kind: 'not_found',
    });
    assert.equal(updated, false);
  });

  it('rejects a non-host without attempting an update', async () => {
    let updated = false;
    const prisma = {
      room: {
        findUnique: async () => room({ hostId: 'host-1' }),
        update: async () => {
          updated = true;
          return room();
        },
      },
    } as unknown as PrismaClient;

    assert.deepEqual(await updateRoomDestination(prisma, '54321', 'guest-1', destination), {
      kind: 'forbidden',
    });
    assert.equal(updated, false);
  });
});
