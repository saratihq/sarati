import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { pinoHttp } from 'pino-http';
import request from 'supertest';

import '../orgs/invite-preview.controller';
import '../orgs/orgs.controller';
import '../triggers/catch.controller';
import '../triggers/chat.controller';
import '../triggers/hooks.controller';
import { INTERNAL_TOKEN_HEADER } from '../platform/internal-token';
import { CREDENTIAL_HEADERS, loggedUrl, REQUEST_LOG_SERIALIZERS } from './request-log-redaction';

interface LoggedRequest {
  url: string;
  headers: Record<string, string>;
  query?: unknown;
  params?: unknown;
}

/** One real request through the request logger, returning the request it logged. */
async function loggedRequest(path: string, headers: Record<string, string> = {}): Promise<LoggedRequest> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = pinoHttp({ serializers: REQUEST_LOG_SERIALIZERS }, sink);
  const server = createServer((req, res) => {
    logger(req, res);
    res.end('ok');
  });
  await request(server).get(path).set(headers);
  return (JSON.parse(lines.join('')) as { req: LoggedRequest }).req;
}

describe('the request log', () => {
  it('never prints a credential header, whichever one carries it', async () => {
    const logged = await loggedRequest('/api/internal/platform-keys/anthropic', {
      Authorization: 'Bearer user-session-credential',
      Cookie: 'orchestr_local_session=cookie-credential',
      [INTERNAL_TOKEN_HEADER]: 'process-credential',
    });

    expect(JSON.stringify(logged)).not.toMatch(
      /user-session-credential|cookie-credential|process-credential/,
    );
    for (const header of CREDENTIAL_HEADERS) expect(logged.headers[header]).toBe('[REDACTED]');
  });

  it('still prints the headers that are not credentials, and a referer as its origin', async () => {
    const logged = await loggedRequest('/api/orgs', {
      'X-Org-Id': 'org-1',
      Referer: 'https://app.example/join/invite-credential?from=mail',
    });
    expect(logged.headers['x-org-id']).toBe('org-1');
    expect(logged.headers.referer).toBe('https://app.example');
  });

  it('prints a capability URL with its credential replaced, and no query or params copy of it', async () => {
    const logged = await loggedRequest(
      '/api/orgs/invites/invite-credential/accept?session_id=stream-credential',
    );
    expect(logged.url).toBe('/api/orgs/invites/[REDACTED]/accept?session_id=[REDACTED]');
    expect(JSON.stringify(logged)).not.toMatch(/invite-credential|stream-credential/);
    expect(logged).not.toHaveProperty('query');
    expect(logged).not.toHaveProperty('params');
  });
});

describe('loggedUrl', () => {
  it.each([
    ['/api/orgs/invites/tok', '/api/orgs/invites/[REDACTED]'],
    ['/API/Orgs/Invites/tok/', '/API/Orgs/Invites/[REDACTED]/'],
    ['/api/hooks/catch/cid', '/api/hooks/catch/[REDACTED]'],
    ['/api/hooks/Catch/cid/', '/api/hooks/Catch/[REDACTED]/'],
    ['/api/catch/cid', '/api/catch/[REDACTED]'],
    ['/api/hooks/wf/production?x=1', '/api/hooks/[REDACTED]/[REDACTED]?x=[REDACTED]'],
    [
      '/api/chat/wf/production/events?session_id=sid&',
      '/api/chat/[REDACTED]/[REDACTED]/events?session_id=[REDACTED]&',
    ],
    ['/api/hooks/composio', '/api/hooks/composio'],
    ['/api/workflows/wf/runs?limit=5&flag', '/api/workflows/wf/runs?limit=[REDACTED]&[REDACTED]'],
    ['/api/orgs/invites/tok#fragment', '/api/orgs/invites/[REDACTED]'],
    ['http://host/api/orgs/invites/tok', '[REDACTED]'],
    ['//api/orgs/invites/tok', '[REDACTED]'],
  ])('%s logs as %s', (url, logged) => {
    expect(loggedUrl(url)).toBe(logged);
  });
});
