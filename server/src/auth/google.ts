import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

export function createGoogleVerifier(clientId: string): GoogleVerifier {
  const client = new OAuth2Client(clientId);
  return async idToken => {
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new Error('Google token is missing the account id or email');
    }
    return {
      googleId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
    };
  };
}
