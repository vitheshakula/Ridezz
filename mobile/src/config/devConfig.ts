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
 * This is the Sandbox ID itself (e.g. "ridezz-jpbfuv"), not the sandbox URL
 * shown in the dashboard (https://ridezz-jpbfuv.sandbox.livekit.io) -- the
 * ID is sent as the X-Sandbox-ID header to LiveKit's fixed sandbox
 * endpoint, so passing the URL instead gets a 404.
 */
export const LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID: string = 'ridezz-jpbfuv';
