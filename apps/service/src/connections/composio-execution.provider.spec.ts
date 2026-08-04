import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { DomainError } from '../common/domain-error';
import type { EnvConfig } from '../config/env.config';
import { ComposioProvider } from './composio.provider';
import { ComposioExecutionProvider } from './composio-execution.provider';

/**
 * The Composio execution fallback against a STUBBED Composio (a local server via COMPOSIO_BASE_URL), proving the
 * real HTTP path: tool mapping, prop→argument translation, and the envelope → RunActionResult / step error.
 */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// The tool the mapper should resolve `slack.send_channel_message` to, with its real snake_case arg names.
const SEND_TOOL = {
  slug: 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
  name: 'Send message to a channel',
  input_parameters: {
    type: 'object',
    properties: { channel: {}, text: {}, thread_ts: {}, as_user: {} },
  },
};

describe('ComposioExecutionProvider (stubbed Composio)', () => {
  let server: Server;
  let baseUrl: string;
  let provider: ComposioExecutionProvider;
  let executeCalls: Array<{ slug: string; body: Record<string, unknown> }> = [];
  let listToolsCalls = 0;
  // Per-test override of what `tools/execute` returns.
  let executeResponse: { status: number; body: unknown } = {
    status: 200,
    body: { successful: true, data: { ok: true, ts: '1710000000.1' }, error: null },
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/v3/tools') {
        listToolsCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [SEND_TOOL], next_cursor: null }));
        return;
      }
      const execMatch = url.pathname.match(/^\/api\/v3\/tools\/execute\/(.+)$/);
      if (req.method === 'POST' && execMatch) {
        void readJson(req).then((body) => {
          executeCalls.push({ slug: decodeURIComponent(execMatch[1]!), body });
          res.writeHead(executeResponse.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(executeResponse.body));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const config = {
      get: () => ({ composioApiKey: 'test-key', composioBaseUrl: baseUrl }) as Partial<EnvConfig>,
    } as unknown as ConfigService<{ env: EnvConfig }, true>;
    const composio = new ComposioProvider({} as DataSource, config);
    provider = new ComposioExecutionProvider(composio);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    executeCalls = [];
    listToolsCalls = 0;
    executeResponse = {
      status: 200,
      body: { successful: true, data: { ok: true, ts: '1710000000.1' }, error: null },
    };
  });

  it('routes by the EXACT slug when the caller supplies the tool — never re-derives it', async () => {
    // The recorded tool is deliberately NOT what the name matcher would pick: it must win,
    // and the tool list must never be fetched.
    const result = await provider.execute({
      appSlug: 'slack',
      actionName: 'send_channel_message',
      props: { channel: 'C123', text: 'hi', threadTs: '1.2' },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: { slug: 'SLACK_EXACT_SEND', inputProperties: ['channel', 'text', 'thread_ts'] },
    });

    expect(result).toEqual({ output: { ok: true, ts: '1710000000.1' } });
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]!.slug).toBe('SLACK_EXACT_SEND'); // exact, not the matched SEND_TOOL
    expect(listToolsCalls).toBe(0); // no name matching — the slug is authoritative
    expect(executeCalls[0]!.body.arguments).toEqual({ channel: 'C123', text: 'hi', thread_ts: '1.2' });
  });

  it('maps the action to a tool, translates props → snake_case args, returns the data', async () => {
    const result = await provider.execute({
      appSlug: 'slack',
      actionName: 'send_channel_message',
      props: { channel: 'C123', text: 'hello', threadTs: '1710304378.4', sendAsBot: true },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
    });

    expect(result.output).toEqual({ ok: true, ts: '1710000000.1' });
    expect(executeCalls).toHaveLength(1);
    const call = executeCalls[0]!;
    expect(call.slug).toBe('SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL');
    // camelCase → snake_case; the required managed-execute fields are present.
    expect(call.body).toMatchObject({
      connected_account_id: 'ca__stub',
      user_id: 'user-1',
      arguments: { channel: 'C123', text: 'hello', thread_ts: '1710304378.4' },
    });
    // sendAsBot has no tool counterpart (tool wants as_user) → dropped, not sent…
    expect((call.body.arguments as Record<string, unknown>).sendAsBot).toBeUndefined();
    // …and the drop is surfaced on the honesty channel, not silent.
    expect(result.warnings).toEqual([
      'Input "sendAsBot" has no matching argument on SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL and was ignored.',
    ]);
  });

  it('turns a ran-but-failed tool into a structured step error (not a 500)', async () => {
    executeResponse = {
      status: 200,
      body: { successful: false, data: {}, error: 'channel_not_found' },
    };
    await expect(
      provider.execute({
        appSlug: 'slack',
        actionName: 'send_channel_message',
        props: { channel: 'bad', text: 'x' },
        connectedAccountId: 'ca__stub',
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({
      constructor: DomainError,
      status: 422,
      message: expect.stringContaining('channel_not_found'),
    });
  });

  it('rejects an action with no equivalent managed tool as a 400 DomainError', async () => {
    await expect(
      provider.execute({
        appSlug: 'slack',
        actionName: 'teleport_widget',
        props: {},
        connectedAccountId: 'ca__stub',
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({ constructor: DomainError, status: 400 });
    expect(executeCalls).toHaveLength(0); // never attempted execution
  });

  // ── Curated override, ADDITIVE merge: the override targets the SAME tool the catalog records,
  //    so the base translation runs first and the SDK-name overlay lands on top. Either naming maps. ──
  const GMAIL_SEND = {
    slug: 'GMAIL_SEND_EMAIL',
    inputProperties: ['recipient_email', 'subject', 'body', 'cc', 'bcc', 'is_html'],
    inputTypes: { cc: 'array', bcc: 'array', is_html: 'boolean' },
    required: ['recipient_email', 'body'],
  };
  const gmailArgs = (): Record<string, unknown> => executeCalls[0]!.body.arguments as Record<string, unknown>;

  it('maps a Composio-NAME payload (recipient_email) straight through the base translation', async () => {
    await provider.execute({
      appSlug: 'gmail',
      actionName: 'send_email',
      props: { recipient_email: 'to@x.com', subject: 'hi', body: 'yo' },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: GMAIL_SEND,
    });
    expect(executeCalls[0]!.slug).toBe('GMAIL_SEND_EMAIL');
    expect(gmailArgs()).toMatchObject({ recipient_email: 'to@x.com', subject: 'hi', body: 'yo' });
  });

  it('maps an SDK-NAME payload (to) via the override overlay to recipient_email', async () => {
    await provider.execute({
      appSlug: 'gmail',
      actionName: 'send_email',
      props: { to: 'to@x.com', subject: 'hi', body: 'yo' },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: GMAIL_SEND,
    });
    expect(gmailArgs().recipient_email).toBe('to@x.com');
    expect(gmailArgs().to).toBeUndefined(); // the SDK alias never reaches Composio
  });

  it("the override overlay wins on conflict — the SDK's cc array beats a raw base string", async () => {
    await provider.execute({
      appSlug: 'gmail',
      actionName: 'send_email',
      // `cc` supplied SDK-style as a comma string; the override's emailList splits it,
      // and the overlay wins over whatever the base produced for the same arg.
      props: { to: 'to@x.com', body: 'yo', cc: 'a@x.com, b@y.com' },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: GMAIL_SEND,
    });
    expect(gmailArgs().recipient_email).toBe('to@x.com');
    expect(gmailArgs().cc).toEqual(['a@x.com', 'b@y.com']);
  });

  // ── Curated override, RETARGET — must NOT be base-merged ──
  it('does NOT base-merge an override that RETARGETS a different tool (calendar.update_event)', async () => {
    // The override deliberately retargets PATCH_EVENT; merging a base built from UPDATE_EVENT's args
    // would smuggle the wrong tool's arguments, so only the overlay reaches Composio.
    await provider.execute({
      appSlug: 'calendar',
      actionName: 'update_event',
      props: {
        calendarId: 'primary',
        eventId: 'ev1',
        title: 'New title',
        start: '2026-01-01T10:00:00Z',
        end: '2026-01-01T11:00:00Z',
      },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: {
        slug: 'GOOGLECALENDAR_UPDATE_EVENT',
        inputProperties: ['event_id', 'start_datetime', 'summary'],
        required: ['event_id', 'start_datetime'],
      },
    });
    expect(executeCalls[0]!.slug).toBe('GOOGLECALENDAR_PATCH_EVENT');
    expect(gmailArgs()).toEqual({
      calendar_id: 'primary',
      event_id: 'ev1',
      summary: 'New title',
      start_time: '2026-01-01T10:00:00Z',
      end_time: '2026-01-01T11:00:00Z',
    });
    // The wrong tool's arg never leaks in, and the retarget is NOT blocked by its required flags.
    expect(gmailArgs().start_datetime).toBeUndefined();
  });

  // ── Pre-flight required validation — a clean 400 before Composio ──
  it('throws a clean 400 listing the missing required inputs BEFORE calling Composio', async () => {
    await expect(
      provider.execute({
        appSlug: 'gmail',
        actionName: 'send_email',
        props: { subject: 'only a subject' }, // no recipient_email, no body
        connectedAccountId: 'ca__stub',
        userId: 'user-1',
        tool: GMAIL_SEND,
      }),
    ).rejects.toMatchObject({
      constructor: DomainError,
      status: 400,
      message: expect.stringContaining('missing required input(s): recipient_email, body'),
    });
    expect(executeCalls).toHaveLength(0); // never burned a Composio call
  });

  it('enforces the curated one-of table (asana team/workspace/user) with a clean 400', async () => {
    await expect(
      provider.execute({
        appSlug: 'asana',
        actionName: 'get_team_memberships',
        props: {}, // none of team/workspace/user → a bare call Composio under-declares
        connectedAccountId: 'ca__stub',
        userId: 'user-1',
        tool: {
          slug: 'ASANA_GET_TEAM_MEMBERSHIPS',
          inputProperties: ['team', 'workspace', 'user', 'opt_fields'],
          required: [],
        },
      }),
    ).rejects.toMatchObject({
      constructor: DomainError,
      status: 400,
      message: expect.stringContaining('provide at least one of: team, workspace, or user'),
    });
    expect(executeCalls).toHaveLength(0);
  });

  it('passes the one-of pre-flight once any member is present, and coerces a JSON-string array param', async () => {
    await provider.execute({
      appSlug: 'asana',
      actionName: 'get_team_memberships',
      props: { team: 't1', opt_fields: '["name","email"]' },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: {
        slug: 'ASANA_GET_TEAM_MEMBERSHIPS',
        inputProperties: ['team', 'workspace', 'user', 'opt_fields'],
        inputTypes: { opt_fields: 'array' },
        required: [],
      },
    });
    expect(executeCalls).toHaveLength(1);
    const args = executeCalls[0]!.body.arguments as Record<string, unknown>;
    expect(args.team).toBe('t1');
    expect(args.opt_fields).toEqual(['name', 'email']); // string → array (P0.4c)
  });

  // ── Warnings channel — non-fatal honesty notes ──
  it('surfaces a genuinely-unmapped prop as a warning (override path), but never a rescued SDK alias', async () => {
    const result = await provider.execute({
      appSlug: 'gmail',
      actionName: 'send_email',
      // `to` is rescued by the overlay (→ recipient_email); `bogusField` is genuinely unknown.
      props: { to: 'to@x.com', body: 'yo', bogusField: 'x' },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: GMAIL_SEND,
    });
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('bogusField'))).toBe(true);
    expect(result.warnings!.some((w) => w.includes('"to"'))).toBe(false); // the alias was rescued, not dropped
  });

  it('surfaces a coercion skip as a soft warning (value left a string against a declared type)', async () => {
    const result = await provider.execute({
      appSlug: 'asana',
      actionName: 'get_team_memberships',
      props: { team: 't1', opt_fields: 'name' }, // not JSON → stays a string against declared array
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: {
        slug: 'ASANA_GET_TEAM_MEMBERSHIPS',
        inputProperties: ['team', 'opt_fields'],
        inputTypes: { opt_fields: 'array' },
        required: [],
      },
    });
    expect(result.warnings!.some((w) => w.includes('opt_fields') && w.includes('declared type'))).toBe(true);
  });

  it('a clean run carries no warnings field', async () => {
    const result = await provider.execute({
      appSlug: 'gmail',
      actionName: 'send_email',
      props: { recipient_email: 'to@x.com', body: 'yo' },
      connectedAccountId: 'ca__stub',
      userId: 'user-1',
      tool: GMAIL_SEND,
    });
    expect(result.warnings).toBeUndefined();
  });
});
