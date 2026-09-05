import express, { Request, Response } from 'express';
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
async function createLiveKitToken(roomCode: string, riderName: string, identity: string) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
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
  return await at.toJwt();
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
app.post('/api/rooms/create', async (req: Request, res: Response): Promise<any> => {
  try {
    const { riderName, userId } = req.body;

    if (!riderName) {
      return res.status(400).json({ message: 'Rider name is required.' });
    }

    // Find host user or fallback to first user
    let user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    if (!user) {
      user = await prisma.user.findFirst();
      if (!user) {
        return res.status(400).json({ message: 'No valid user found to host the room.' });
      }
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
      },
    });

    const identity = `${riderName.trim()}_${Date.now()}`;
    const token = await createLiveKitToken(room.code, riderName, identity);

    return res.status(201).json({
      roomCode: room.code,
      roomId: room.id,
      token,
      serverUrl: LIVEKIT_URL,
    });
  } catch (error) {
    console.error('Create room error:', error);
    return res.status(500).json({ message: 'Failed to create room.' });
  }
});

// 🔹 2. JOIN ROOM (Validates 6-character code against DB)
app.post('/api/rooms/join', async (req: Request, res: Response): Promise<any> => {
  try {
    const { roomCode, riderName } = req.body;

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

    const identity = `${riderName.trim()}_${Date.now()}`;
    const token = await createLiveKitToken(room.code, riderName, identity);

    return res.status(200).json({
      roomCode: room.code,
      roomId: room.id,
      token,
      serverUrl: LIVEKIT_URL,
    });
  } catch (error) {
    console.error('Join room error:', error);
    return res.status(500).json({ message: 'Failed to join room.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Ridezz Server running on http://localhost:${PORT}`);
});