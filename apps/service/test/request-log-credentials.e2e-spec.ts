import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { bootService, THIS_SERVICE, type ServiceProcess } from './support/service-process';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

interface LogLine {
  msg?: string;
  responseTime?: number;
  req?: { id?: string; method?: string; url?: string; headers?: Record<string, string> };
}

interface Sent {
  id: string;
  method: string;
  logged: string;
}

const REDACTED = '[REDACTED]';

const hash = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

// DBOS writes plain-text lines beside the service's pino lines.
function logLines(log: string): LogLine[] {
  return log
    .split('\n')
    .filter((line) => line.startsWith('{"level":'))
    .map((line) => JSON.parse(line) as LogLine);
}

describe('the service log never prints a credential a request carried in its URL (e2e, own process)', () => {
  const owner = randomUUID();
  const joiner = randomUUID();
  const ownerKey = `ork_e2e_owner_${randomBytes(12).toString('hex')}`;
  const joinerKey = `ork_e2e_joiner_${randomBytes(12).toString('hex')}`;
  const hookWorkflow = randomUUID();
  const chatWorkflow = randomUUID();
  const chatSession = `session-${randomBytes(12).toString('hex')}`;
  const sent: Sent[] = [];
  let db: Client;
  let service: ServiceProcess | undefined;
  let inviteToken = '';
  let catchId = '';
  let previewId = '';
  let unhandledId = '';

  async function send(
    method: string,
    path: string,
    logged: string,
    opts: { key?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const id = `log-e2e-${randomBytes(6).toString('hex')}`;
    sent.push({ id, method, logged });
    return fetch(`${service!.base}${path}`, {
      method,
      headers: {
        'x-request-id': id,
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...opts.headers,
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  async function endedLines(): Promise<Map<string, LogLine>> {
    for (let i = 0; i < 150; i++) {
      const ended = new Map(
        logLines(service!.log())
          .filter((line) => line.responseTime !== undefined && line.req?.id !== undefined)
          .map((line) => [line.req!.id!, line]),
      );
      if (sent.every(({ id }) => ended.has(id))) return ended;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the request log never ended every request\n${service!.log().slice(-4_000)}`);
  }

  beforeAll(async () => {
    const databaseUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const personalOwner = randomUUID();
    const personalJoiner = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner@log-e2e.local', 'Owner', now(), now()), ($2, 'joiner@log-e2e.local', 'Joiner', now(), now())`,
      [owner, joiner],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Owner', true, now(), now()), ($2, 'Joiner', true, now(), now())`,
      [personalOwner, personalJoiner],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $3, $4, 'owner', now())`,
      [personalOwner, owner, personalJoiner, joiner],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'owner', $2, $3, now()), (gen_random_uuid(), $4, 'joiner', $5, $6, now())`,
      [owner, hash(ownerKey), ownerKey.slice(0, 12), joiner, hash(joinerKey), joinerKey.slice(0, 12)],
    );
    service = await bootService({
      service: THIS_SERVICE,
      databaseUrl,
      env: { MOCK_AUTH: 'false', CLERK_ISSUER: '', LOG_LEVEL: 'info' },
    });
  }, 90_000);

  afterAll(async () => {
    await service?.crash();
    await db.end();
  }, 30_000);

  it('an invite is created, previewed from its join page, fails while its table is unreachable, and is accepted', async () => {
    const org = await send('POST', '/api/orgs', '/api/orgs', { key: ownerKey, body: { name: 'Acme' } });
    expect(org.status).toBe(201);
    const orgId = ((await org.json()) as { id: string }).id;

    const invite = await send('POST', `/api/orgs/${orgId}/invites`, `/api/orgs/${orgId}/invites`, {
      key: ownerKey,
      body: { email: 'joiner@log-e2e.local', role: 'owner' },
    });
    expect(invite.status).toBe(201);
    inviteToken = ((await invite.json()) as { token: string }).token;
    expect(inviteToken).toMatch(/^[0-9a-f]{48}$/);

    const preview = await send('GET', `/api/orgs/invites/${inviteToken}`, `/api/orgs/invites/${REDACTED}`, {
      headers: { referer: `${service!.base}/join/${inviteToken}` },
    });
    previewId = sent.at(-1)!.id;
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ org_id: orgId, role: 'owner' });

    await db.query('ALTER TABLE org_invites RENAME TO org_invites_parked');
    const unhandled = await send(
      'GET',
      `/api/orgs/invites/${inviteToken}`,
      `/api/orgs/invites/${REDACTED}`,
    ).finally(() => db.query('ALTER TABLE org_invites_parked RENAME TO org_invites'));
    unhandledId = sent.at(-1)!.id;
    expect(unhandled.status).toBe(500);

    const accept = await send(
      'POST',
      `/api/orgs/invites/${inviteToken}/accept`,
      `/api/orgs/invites/${REDACTED}/accept`,
      { key: joinerKey },
    );
    expect(accept.status).toBe(200);
    expect(await accept.json()).toEqual({ org_id: orgId, name: 'Acme' });
  });

  it('a test-event catch is minted, delivered to and polled', async () => {
    const minted = await send('POST', '/api/catch', '/api/catch', { key: ownerKey });
    expect(minted.status).toBe(201);
    catchId = ((await minted.json()) as { catch_id: string }).catch_id;

    const caught = await send('POST', `/api/hooks/catch/${catchId}`, `/api/hooks/catch/${REDACTED}`, {
      body: { hello: 'world' },
    });
    expect(caught.status).toBe(201);

    const polled = await send('GET', `/api/catch/${catchId}`, `/api/catch/${REDACTED}`, { key: ownerKey });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toEqual({
      received: true,
      payload: { body: { hello: 'world' }, hello: 'world' },
    });
  });

  it('the webhook and chat intakes answer on their capability paths, and the chat stream opens', async () => {
    const hook = await send(
      'POST',
      `/api/hooks/${hookWorkflow}/production`,
      `/api/hooks/${REDACTED}/${REDACTED}`,
      { body: { event: 'push' } },
    );
    expect(hook.status).toBe(404);
    expect(await hook.json()).toEqual({ detail: 'Webhook not found' });

    const chat = await send(
      'POST',
      `/api/chat/${chatWorkflow}/production`,
      `/api/chat/${REDACTED}/${REDACTED}`,
      {
        body: { chatInput: 'hi' },
      },
    );
    expect(chat.status).toBe(404);
    expect(await chat.json()).toEqual({ detail: 'Chat workflow not found' });

    const closing = new AbortController();
    const stream = await send(
      'GET',
      `/api/chat/${chatWorkflow}/production/events?session_id=${chatSession}`,
      `/api/chat/${REDACTED}/${REDACTED}/events?session_id=${REDACTED}`,
      { signal: closing.signal },
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    closing.abort();
  });

  it('no line the service wrote carries any of those credentials', async () => {
    await endedLines();
    const log = service!.log();
    for (const credential of [
      inviteToken,
      catchId,
      hookWorkflow,
      chatWorkflow,
      chatSession,
      ownerKey,
      joinerKey,
    ]) {
      expect(log).not.toContain(credential);
    }
  });

  it('each request is still logged by its id, method and route, with only the credential replaced', async () => {
    const ended = await endedLines();
    for (const { id, method, logged } of sent) {
      expect({ id, method: ended.get(id)?.req?.method, url: ended.get(id)?.req?.url }).toEqual({
        id,
        method,
        url: logged,
      });
    }
  });

  it('a referer is logged as its origin, and an unhandled error on a capability route names only its route', async () => {
    const ended = await endedLines();
    expect(ended.get(previewId)?.req?.headers?.referer).toBe(service!.base);

    const unhandled = logLines(service!.log()).find(
      (line) => line.req?.id === unhandledId && line.msg?.startsWith('Unhandled error'),
    );
    expect(unhandled?.msg).toContain(
      `on GET /api/orgs/invites/${REDACTED}: relation "org_invites" does not exist`,
    );
  });
});
