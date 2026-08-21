/**
 * Development-only configuration.
 *
 * LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID identifies LiveKit Cloud's Development Token Server
 * for the Ridezz project (LiveKit Cloud dashboard -> Ridezz project -> Sandbox / Development
 * Token Server). It is not the LiveKit API secret and is meant to be bundled in a client for
 * prototyping, but it is still environment-specific, so it lives here rather than in
 * `services/livekit.ts`. This flow is temporary and will be replaced by `server/`'s own token
 * endpoint before production.
 *
 * Fill in the real value below before joining a room will work.
 */
export const LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID = 'PASTE_TOKEN_SERVER_ID_HERE';
