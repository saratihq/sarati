import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import request from 'supertest';

import { INTERNAL_TOKEN_HEADER } from '../platform/internal-token';
import { CREDENTIAL_HEADERS, REQUEST_LOG_REDACTION } from './request-log-redaction';

/** One real request through the request logger, returning the line it wrote. */
async function loggedRequest(headers: Record<string, string>): Promise<string> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = pinoHttp({ redact: REQUEST_LOG_REDACTION }, sink);
  const server = createServer((req, res) => {
    logger(req, res);
    res.end('ok');
  });
  await request(server).get('/api/internal/platform-keys/anthropic').set(headers);
  return lines.join('');
}

describe('the request log', () => {
  it('never prints a credential header, whichever one carries it', async () => {
    const line = await loggedRequest({
      Authorization: 'Bearer user-session-credential',
      Cookie: 'orchestr_local_session=cookie-credential',
      [INTERNAL_TOKEN_HEADER]: 'process-credential',
    });

    expect(line).not.toContain('user-session-credential');
    expect(line).not.toContain('cookie-credential');
    expect(line).not.toContain('process-credential');
    const logged = (JSON.parse(line) as { req: { headers: Record<string, string> } }).req.headers;
    for (const header of CREDENTIAL_HEADERS) expect(logged[header]).toBe('[REDACTED]');
  });

  it('still prints the headers that are not credentials', async () => {
    const line = await loggedRequest({ 'X-Org-Id': 'org-1' });
    const logged = (JSON.parse(line) as { req: { headers: Record<string, string> } }).req.headers;
    expect(logged['x-org-id']).toBe('org-1');
  });
});
