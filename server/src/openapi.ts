const errorCodes = [
  'INVALID_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'INVALID_CREDENTIALS',
  'GOOGLE_ONLY_ACCOUNT',
  'GOOGLE_TOKEN_REJECTED',
  'EMAIL_NOT_VERIFIED',
  'NOT_ALLOWED',
  'EMAIL_DOMAIN_NOT_SUPPORTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ACCOUNT_NOT_FOUND',
  'ROOM_NOT_FOUND',
  'EMAIL_TAKEN',
  'GOOGLE_ACCOUNT_CONFLICT',
  'ROOM_CODE_CONFLICT',
  'RATE_LIMITED',
  'GOOGLE_SIGN_IN_DISABLED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schema: object) => ({ content: { 'application/json': { schema } } });

const ok = (description: string, schema: object) => ({ description, ...json(schema) });

const error = (description: string) => ok(description, ref('Error'));

const commonErrors = {
  '429': error('Rate limit exceeded'),
  '500': error('Unexpected server error'),
};

const authenticatedErrors = {
  '401': error('Missing, invalid or expired token, or the account is no longer allowed'),
  ...commonErrors,
};

const destinationInput = {
  destinationName: { type: 'string', maxLength: 200 },
  destinationLat: { type: 'number', minimum: -90, maximum: 90 },
  destinationLng: { type: 'number', minimum: -180, maximum: 180 },
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Ridezz API',
    version: '1.0.0',
    description:
      'Accounts, ride rooms and LiveKit token issuance for the Ridezz app. Every path is served ' +
      'under /api/v1 and, for older app builds, under /api.',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/signup': {
      post: {
        summary: 'Create a password account (alias: POST /auth/register)',
        security: [],
        requestBody: { required: true, ...json(ref('SignupRequest')) },
        responses: {
          '201': ok('Account created', ref('Session')),
          '400': error('Missing field or failed validation'),
          '403': error('Address is not on the allow list'),
          '409': error('An account with this email already exists'),
          ...commonErrors,
        },
      },
    },
    '/auth/register': {
      post: {
        summary: 'Alias of POST /auth/signup',
        security: [],
        requestBody: { required: true, ...json(ref('SignupRequest')) },
        responses: {
          '201': ok('Account created', ref('Session')),
          '400': error('Missing field or failed validation'),
          '403': error('Address is not on the allow list'),
          '409': error('An account with this email already exists'),
          ...commonErrors,
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Sign in with email and password',
        security: [],
        requestBody: { required: true, ...json(ref('LoginRequest')) },
        responses: {
          '200': ok('Signed in', ref('Session')),
          '400': error('Email or password missing'),
          '401': error('Invalid credentials, or the account uses Google sign-in'),
          '403': error('Address is not on the allow list'),
          ...commonErrors,
        },
      },
    },
    '/auth/google/config': {
      get: {
        summary: 'Google OAuth client id the app must request its ID token for',
        security: [],
        responses: {
          '200': ok('Google sign-in is enabled', {
            type: 'object',
            required: ['clientId'],
            properties: { clientId: { type: 'string' } },
          }),
          '503': error('Google sign-in is not configured'),
        },
      },
    },
    '/auth/google': {
      post: {
        summary: 'Sign in or sign up with a Google ID token',
        security: [],
        requestBody: { required: true, ...json(ref('GoogleRequest')) },
        responses: {
          '200': ok('Signed in', ref('Session')),
          '400': error('Missing token or invalid mode'),
          '401': error('Token rejected or Google email not verified'),
          '403': error('Not a Gmail account, or not on the allow list'),
          '404': error('No account for this Google account in login mode (ACCOUNT_NOT_FOUND)'),
          '409': error('Email already linked to a different Google account'),
          '503': error('Google sign-in is not configured or Google is temporarily unreachable'),
          ...commonErrors,
        },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Exchange a refresh token for a new access token and refresh token',
        description:
          'Refresh tokens rotate: each one works once. Presenting a used token revokes every token ' +
          'from the same sign-in.',
        security: [],
        requestBody: { required: true, ...json(ref('RefreshRequest')) },
        responses: {
          '200': ok('New tokens', ref('SessionTokens')),
          '400': error('Missing or malformed refresh token'),
          '401': error('Refresh token unknown, expired, reused or revoked (SESSION_EXPIRED)'),
          ...commonErrors,
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Revoke the refresh token and every token from the same sign-in',
        security: [],
        requestBody: { required: true, ...json(ref('RefreshRequest')) },
        responses: { '204': { description: 'Signed out (also returned for unknown tokens)' } },
      },
    },
    '/auth/me': {
      get: {
        summary: 'The signed-in rider',
        responses: { '200': ok('Current rider', ref('UserEnvelope')), ...authenticatedErrors },
      },
    },
    '/user/profile': {
      get: {
        summary: 'The signed-in rider, assigning a room code if missing',
        responses: { '200': ok('Current rider', ref('UserEnvelope')), ...authenticatedErrors },
      },
    },
    '/rooms/create': {
      post: {
        summary: "Host the rider's permanent room, creating or reusing it",
        requestBody: {
          ...json({
            type: 'object',
            properties: { riderName: { type: 'string', maxLength: 24 }, ...destinationInput },
          }),
        },
        responses: {
          '201': ok('Room ready', ref('RoomAccess')),
          '409': error('The room code is owned by another rider'),
          ...authenticatedErrors,
        },
      },
    },
    '/rooms/join': {
      post: {
        summary: 'Join a room by its 5-digit code',
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['roomCode'],
            properties: {
              roomCode: { type: 'string', pattern: '^[1-9][0-9]{4}$' },
              riderName: { type: 'string', maxLength: 24 },
            },
          }),
        },
        responses: {
          '200': ok('Joined', ref('RoomAccess')),
          '400': error('Invalid room code'),
          '404': error('Room not found'),
          ...authenticatedErrors,
        },
      },
    },
    '/rooms/{roomCode}/destination': {
      patch: {
        summary: "Change the room's destination (host only)",
        parameters: [
          {
            name: 'roomCode',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^[1-9][0-9]{4}$' },
          },
        ],
        requestBody: {
          required: true,
          ...json({
            type: 'object',
            required: ['destinationLat', 'destinationLng'],
            properties: destinationInput,
          }),
        },
        responses: {
          '200': ok('Destination updated', ref('Destination')),
          '400': error('Invalid room code or destination'),
          '403': error('Only the ride creator can change the destination'),
          '404': error('Room not found'),
          ...authenticatedErrors,
        },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'This document',
        security: [],
        responses: { '200': { description: 'OpenAPI document' } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['message', 'code'],
        properties: {
          message: { type: 'string', description: 'Human-readable, safe to show to the rider' },
          code: { type: 'string', enum: errorCodes },
        },
      },
      User: {
        type: 'object',
        required: ['id', 'email', 'name', 'emailVerified', 'roomCode'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          emailVerified: { type: 'boolean' },
          roomCode: { type: ['string', 'null'], pattern: '^[1-9][0-9]{4}$' },
        },
      },
      UserEnvelope: {
        type: 'object',
        required: ['user'],
        properties: { user: ref('User') },
      },
      SessionTokens: {
        type: 'object',
        required: ['token', 'refreshToken', 'expiresIn'],
        properties: {
          token: {
            type: 'string',
            description: 'Access token (JWT). 15 minutes under /api/v1, 30 days under /api',
          },
          refreshToken: { type: 'string', description: 'Opaque, single-use, valid for 30 days' },
          expiresIn: { type: 'integer', description: 'Access token lifetime in seconds' },
        },
      },
      Session: {
        allOf: [
          ref('SessionTokens'),
          { type: 'object', required: ['user'], properties: { user: ref('User') } },
        ],
      },
      RefreshRequest: {
        type: 'object',
        required: ['refreshToken'],
        properties: { refreshToken: { type: 'string' } },
      },
      Destination: {
        type: 'object',
        required: ['destinationName', 'destinationLat', 'destinationLng'],
        properties: {
          destinationName: { type: ['string', 'null'] },
          destinationLat: { type: ['number', 'null'] },
          destinationLng: { type: ['number', 'null'] },
        },
      },
      RoomAccess: {
        allOf: [
          {
            type: 'object',
            required: ['roomCode', 'roomId', 'isHost', 'token', 'serverUrl'],
            properties: {
              roomCode: { type: 'string' },
              roomId: { type: 'string', format: 'uuid' },
              isHost: { type: 'boolean' },
              token: { type: 'string', description: 'LiveKit access token, valid for 6 hours' },
              serverUrl: { type: 'string', description: 'LiveKit WebSocket URL' },
            },
          },
          ref('Destination'),
        ],
      },
      SignupRequest: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 24 },
          email: { type: 'string', format: 'email', description: 'Gmail address' },
          password: { type: 'string', minLength: 8, description: 'At most 72 bytes' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: { email: { type: 'string' }, password: { type: 'string' } },
      },
      GoogleRequest: {
        type: 'object',
        required: ['idToken'],
        properties: {
          idToken: { type: 'string' },
          mode: { type: 'string', enum: ['login', 'signup'], default: 'login' },
        },
      },
    },
  },
} as const;
