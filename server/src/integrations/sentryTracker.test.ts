import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createSentryTracker } from './errorTracker';

describe('createSentryTracker', () => {
  const envelopes: string[] = [];
  let server: Server;
  let dsn: string;

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        envelopes.push(
          (req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8'),
        );
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    dsn = `http://publickey@127.0.0.1:${(server.address() as AddressInfo).port}/1`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('sends the exception with tags and the user id, and nothing more about the user', async () => {
    const tracker = createSentryTracker({ dsn, release: 'abc123', environment: 'test' });
    tracker.capture(new Error('payment exploded'), {
      event: 'http_error',
      requestId: 'req-42',
      path: '/api/v1/rooms/create',
      userId: 'user-7',
    });
    await tracker.flush(2000);

    const sent = envelopes.join('\n');
    assert.match(sent, /payment exploded/);
    assert.match(sent, /"requestId":"req-42"/);
    assert.match(sent, /"release":"abc123"/);
    assert.match(sent, /"environment":"test"/);
    assert.match(sent, /"user":\{"id":"user-7"\}/);
  });
});
