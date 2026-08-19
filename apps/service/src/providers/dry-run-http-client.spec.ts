import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDirectAuth } from '@sarati/actions-sdk';
import type { AuthHandle } from '@sarati/actions-sdk';

import { DryRunHttpClient, DryRunSkipped } from './dry-run-http-client';

/** Records every request that actually reaches the server. */
function captureServer(): Promise<{ url: string; hits: Array<{ method: string }>; close: () => void }> {
  const hits: Array<{ method: string }> = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      hits.push({ method: req.method ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"real":true}');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
        close: () => server.close(),
      });
    });
  });
}

const noneAuth = (): AuthHandle => createDirectAuth({ type: 'none' }, { type: 'none' });

describe('DryRunHttpClient (— preview without firing side effects)', () => {
  it('does NOT send a mutating request — it refuses at the seam, server never hit', async () => {
    const srv = await captureServer();
    try {
      const client = new DryRunHttpClient();
      // Refused, not stubbed: a synthetic body would fail the action's own response validation.
      await expect(client.post(`${srv.url}/write`, { auth: noneAuth(), body: { x: 1 } })).rejects.toThrow(
        DryRunSkipped,
      );
      await expect(client.put(`${srv.url}/write`, { auth: noneAuth(), body: {} })).rejects.toThrow(
        DryRunSkipped,
      );
      expect(client.skipped).toEqual([
        { method: 'POST', url: `${srv.url}/write` },
        { method: 'PUT', url: `${srv.url}/write` },
      ]);
      expect(srv.hits).toEqual([]); // no write ever reached the server
    } finally {
      srv.close();
    }
  });

  it('DOES execute a GET — reads are real so downstream data flows', async () => {
    const srv = await captureServer();
    try {
      const client = new DryRunHttpClient();
      const res = await client.get(`${srv.url}/read`, { auth: noneAuth() });
      expect(res.data).toEqual({ real: true });
      expect(srv.hits).toEqual([{ method: 'GET' }]);
    } finally {
      srv.close();
    }
  });
});
