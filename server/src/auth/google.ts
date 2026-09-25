import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  /** Google's stable, unique account id (the token's `sub`). */
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/** Resolves with the verified identity, or rejects if the token is forged, expired or not for us. */
export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

/**
 * Verifies a Google ID token the mobile app obtained from Google Sign-In: checks Google's
 * signature, expiry and issuer, and that the token was minted for OUR client id (`audience`) --
 * without that last check any app's Google token would be accepted here. No client secret is
 * needed for this flow.
 */
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
