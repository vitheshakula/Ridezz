import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { AccessToken } from 'livekit-server-sdk';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'ridezz_super_secret_jwt_key_2026';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';

interface AuthClaims {
  userId: string;
  riderName: string;
}

type AuthenticatedRequest = Request & { auth: AuthClaims };

app.use(cors());
app.use(express.json());

// Helper: 6-character alphanumeric code generator (A-Z, 0-9)
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips ambiguous 0/O, 1/I
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Helper: Create LiveKit JWT token
async function createLiveKitToken(
  roomCode: string,
  riderName: string,
  identity: string,
  userId: string,
  isHost: boolean,
) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
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
  return await at.toJwt();
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ message: 'Authentication required.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (
      typeof decoded === 'string' ||
      typeof decoded.userId !== 'string' ||
      typeof decoded.riderName !== 'string'
    ) {
      throw new Error('Invalid token payload');
    }
    (req as AuthenticatedRequest).auth = {
      userId: decoded.userId,
      riderName: decoded.riderName,
    };
    next();
  } catch {
    res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }
}

function isValidCoordinate(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

// ---------------- AUTH ROUTES ----------------

app.post('/api/auth/signup', async (req: Request, res: Response): Promise<any> => {
  try {
    const { rider_name, email, password } = req.body;
    if (!rider_name || !email || !password) {
      return res.status(400).json({ message: 'All fields are required.' });
    }
    const existingUser = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(409).json({ message: 'Email already exists.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: { riderName: rider_name, email: email.toLowerCase(), password: hashedPassword },
    });
    return res.status(201).json({
      user: { id: newUser.id, rider_name: newUser.riderName, email: newUser.email },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response): Promise<any> => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }
    const token = jwt.sign({ userId: user.id, riderName: user.riderName }, JWT_SECRET, { expiresIn: '30d' });
    return res.status(200).json({
      token,
      user: { id: user.id, rider_name: user.riderName, email: user.email },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// ---------------- ROOM ROUTES ----------------

// 🔹 1. CREATE ROOM (Generates unique 6-character code & stores in DB)
app.post('/api/rooms/create', authenticate, async (req: Request, res: Response): Promise<any> => {
  try {
    const { destinationName, destinationLat, destinationLng } = req.body;
    const { userId, riderName } = (req as AuthenticatedRequest).auth;

    if (!riderName) {
      return res.status(400).json({ message: 'Rider name is required.' });
    }

    const hasDestination = isValidCoordinate(destinationLat, destinationLng);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(401).json({ message: 'Your account no longer exists.' });
    }

    // Generate unique 6-char code
    let code = generateRoomCode();
    let collision = await prisma.room.findUnique({ where: { code } });
    while (collision) {
      code = generateRoomCode();
      collision = await prisma.room.findUnique({ where: { code } });
    }

    // Save to SQLite
    const room = await prisma.room.create({
      data: {
        code,
        name: `${riderName}'s Ride`,
        hostId: user.id,
        destinationName: hasDestination ? destinationName ?? null : null,
        destinationLat: hasDestination ? destinationLat : null,
        destinationLng: hasDestination ? destinationLng : null,
      },
    });

    const identity = `${user.id}_${Date.now()}`;
    const token = await createLiveKitToken(room.code, user.riderName, identity, user.id, true);

    return res.status(201).json({
      roomCode: room.code,
      roomId: room.id,
      isHost: true,
      token,
      serverUrl: LIVEKIT_URL,
      destinationName: room.destinationName,
      destinationLat: room.destinationLat,
      destinationLng: room.destinationLng,
    });
  } catch (error) {
    console.error('Create room error:', error);
    return res.status(500).json({ message: 'Failed to create room.' });
  }
});

// 🔹 2. JOIN ROOM (Validates 6-character code against DB)
app.post('/api/rooms/join', authenticate, async (req: Request, res: Response): Promise<any> => {
  try {
    const { roomCode } = req.body;
    const { userId, riderName } = (req as AuthenticatedRequest).auth;

    if (!roomCode || !riderName) {
      return res.status(400).json({ message: 'Room code and rider name are required.' });
    }

    const code = roomCode.trim().toUpperCase();

    // Verify room exists in database
    const room = await prisma.room.findUnique({
      where: { code },
    });

    if (!room) {
      return res.status(404).json({ message: 'Ride room not found. Check the 6-character code.' });
    }

    const isHost = room.hostId === userId;
    const identity = `${userId}_${Date.now()}`;
    const token = await createLiveKitToken(room.code, riderName, identity, userId, isHost);

    return res.status(200).json({
      roomCode: room.code,
      roomId: room.id,
      isHost,
      token,
      serverUrl: LIVEKIT_URL,
      destinationName: room.destinationName,
      destinationLat: room.destinationLat,
      destinationLng: room.destinationLng,
    });
  } catch (error) {
    console.error('Join room error:', error);
    return res.status(500).json({ message: 'Failed to join room.' });
  }
});

app.patch(
  '/api/rooms/:roomCode/destination',
  authenticate,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const code = req.params.roomCode?.trim().toUpperCase();
      const { userId } = (req as AuthenticatedRequest).auth;
      const { destinationName, destinationLat, destinationLng } = req.body;

      if (!code || !isValidCoordinate(destinationLat, destinationLng)) {
        return res.status(400).json({ message: 'A valid destination is required.' });
      }

      const room = await prisma.room.findUnique({ where: { code } });
      if (!room) {
        return res.status(404).json({ message: 'Ride room not found.' });
      }
      if (room.hostId !== userId) {
        return res.status(403).json({ message: 'Only the ride creator can change the destination.' });
      }

      const updated = await prisma.room.update({
        where: { code },
        data: {
          destinationName:
            typeof destinationName === 'string' && destinationName.trim()
              ? destinationName.trim().slice(0, 200)
              : null,
          destinationLat,
          destinationLng,
        },
      });

      return res.status(200).json({
        destinationName: updated.destinationName,
        destinationLat: updated.destinationLat,
        destinationLng: updated.destinationLng,
      });
    } catch (error) {
      console.error('Update destination error:', error);
      return res.status(500).json({ message: 'Failed to update destination.' });
    }
  },
);

app.listen(PORT, () => {
  console.log(`🚀 Ridezz Server running on http://localhost:${PORT}`);
});
