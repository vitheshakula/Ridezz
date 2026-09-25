import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { createGoogleVerifier } from './auth/google';
import { loadEnv } from './config/env';

dotenv.config();

const env = loadEnv();
const prisma = new PrismaClient();
const app = createApp({
  prisma,
  env,
  verifyGoogleIdToken: env.googleClientId ? createGoogleVerifier(env.googleClientId) : undefined,
});

app.listen(env.port, () => {
  console.log(`🚀 Ridezz Server running on http://localhost:${env.port}`);
  console.log(env.googleClientId ? 'Google sign-in: enabled' : 'Google sign-in: disabled (GOOGLE_CLIENT_ID not set)');
  console.log(
    env.allowedEmails
      ? `Access: private testing, ${env.allowedEmails.size} allowed address(es)`
      : 'Access: open to any Gmail account (set ALLOWED_EMAILS to restrict)',
  );
});
