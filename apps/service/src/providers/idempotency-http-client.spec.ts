import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDirectAuth } from '@sarati/actions-sdk';
import type { AuthHandle } from '@sarati/actions-sdk';
import type { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../config/env.config';
import { IdempotencyHttpClient } from './idempotency-http-client';
import { SdkActionsProvider } from './sdk-actions.provider';

/** Captures the method + idempotency-key header of every inbound request. */
function captureServer(): Promise<{
  url: string;
  seen: Array<{ method: string; key?: string }>;
  close: () => void;
}> {
  const seen: Array<{ method: string; key?: string }> = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      seen.push({ method: req.method ?? '', key: req.headers['idempotency-key'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    });
  });
}

const noneAuth = (): AuthHandle => createDirectAuth({ type: 'none' }, { type: 'none' });

describe('IdempotencyHttpClient (B7 durability — deterministic idempotency keys)', () => {
  it('stamps a per-call-incrementing key on mutating requests; a replay would re-issue the same keys', async () => {
    const srv = await captureServer();
    try {
      const client = new IdempotencyHttpClient('run-1:step-a');
      await client.post(`${srv.url}/a`, { auth: noneAuth(), body: {} });
      await client.post(`${srv.url}/b`, { auth: noneAuth(), body: {} });
      await client.put(`${srv.url}/c`, { auth: noneAuth(), body: {} });

      expect(srv.seen.map((s) => s.key)).toEqual(['run-1:step-a#1', 'run-1:step-a#2', 'run-1:step-a#3']);

      // A fresh client for the SAME step (a DBOS replay / a retry) re-issues from #1.
      const replay = new IdempotencyHttpClient('run-1:step-a');
      await replay.post(`${srv.url}/a`, { auth: noneAuth(), body: {} });
      expect(srv.seen[3]?.key).toBe('run-1:step-a#1');
    } finally {
      srv.close();
    }
  });

  it('does not stamp safe (GET/HEAD) requests', async () => {
    const srv = await captureServer();
    try {
      const client = new IdempotencyHttpClient('run-2:step-x');
      await client.get(`${srv.url}/x`, { auth: noneAuth() });
      expect(srv.seen[0]).toEqual({ method: 'GET', key: undefined });
    } finally {
      srv.close();
    }
  });

  it("never clobbers an action's own Idempotency-Key", async () => {
    const srv = await captureServer();
    try {
      const client = new IdempotencyHttpClient('run-3:step-y');
      await client.post(`${srv.url}/y`, {
        auth: noneAuth(),
        body: {},
        headers: { 'Idempotency-Key': 'mine' },
      });
      expect(srv.seen[0]?.key).toBe('mine');
    } finally {
      srv.close();
    }
  });

  it('SdkActionsProvider threads the step key onto a real action call (wiring)', async () => {
    const srv = await captureServer();
    try {
      const config = {
        get: () => ({ composioApiKey: '', composioBaseUrl: '' }) as Partial<EnvConfig>,
      } as unknown as ConfigService<{ env: EnvConfig }, true>;
      const provider = new SdkActionsProvider(config);
      await provider.runAction({
        externalUserId: 'u',
        actionId: 'http.send_request',
        props: { method: 'POST', url: `${srv.url}/hook`, body: { hi: 1 } },
        idempotencyKey: 'u:run-9:node-a',
      });
      expect(srv.seen[0]).toEqual({ method: 'POST', key: 'u:run-9:node-a#1' });
    } finally {
      srv.close();
    }
  });
});
