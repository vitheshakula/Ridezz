import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { createLiveKitToken } from './livekitService';

interface LiveKitClaims extends JwtPayload {
  name?: string;
  metadata?: string;
  video?: {
    roomJoin?: boolean;
    room?: string;
    canPublish?: boolean;
    canPublishData?: boolean;
    canSubscribe?: boolean;
  };
}

describe('createLiveKitToken', () => {
  it('preserves the participant, metadata, room grants and six-hour TTL', async () => {
    const credentials = {
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret'.padEnd(40, 'x'),
    };
    const roomCode = '54321';
    const riderName = 'Alex Rider';
    const userId = 'user-123';
    const before = Date.now();

    const token = await createLiveKitToken(credentials, roomCode, riderName, userId, true);
    const after = Date.now();
    const claims = jwt.verify(token, credentials.apiSecret, {
      algorithms: ['HS256'],
    }) as LiveKitClaims;

    assert.equal(claims.iss, credentials.apiKey);
    assert.equal(claims.name, riderName);
    assert.deepEqual(JSON.parse(claims.metadata ?? ''), { userId, isHost: true });

    const identity = claims.sub;
    assert.equal(typeof identity, 'string');
    const identityTimestamp = Number((identity as string).slice(userId.length + 1));
    assert.ok(identity?.startsWith(`${userId}_`));
    assert.ok(Number.isInteger(identityTimestamp));
    assert.ok(identityTimestamp >= before - 1000 && identityTimestamp <= after + 1000);

    assert.equal(claims.video?.roomJoin, true);
    assert.equal(claims.video?.room, roomCode);
    assert.equal(claims.video?.canPublish, true);
    assert.equal(claims.video?.canPublishData, true);
    assert.equal(claims.video?.canSubscribe, true);

    assert.equal(typeof claims.nbf, 'number');
    assert.equal(typeof claims.exp, 'number');
    assert.equal((claims.exp ?? 0) - (claims.nbf ?? 0), 6 * 60 * 60);
  });
});
