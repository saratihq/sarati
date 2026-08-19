import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** `GET /api/triggers/catalog` IS the trigger palette — the general node-type catalog excludes triggers. */
describe('trigger catalog (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    // Composio projection OFF so the palette is deterministic and makes no live call.

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  it('native webhook first, then the SDK + Composio triggers — no vendor strings', async () => {
    const res = await http().get('/api/triggers/catalog').expect(200);
    const triggers = res.body.triggers as Array<Record<string, unknown>>;
    expect(triggers[0]).toEqual({
      name: 'Incoming webhook',
      type: 'orchestr:webhook',
      category: 'control',
      description: 'Fires the workflow when this URL receives a POST',
      parameters: {},
      auth: 'none',
    });
    for (const t of triggers) {
      // `sample` and `authScheme` are the ONLY optional extras, and both are SDK-only (asserted below).
      expect(
        Object.keys(t)
          .filter((k) => k !== 'sample' && k !== 'authScheme')
          .sort(),
      ).toEqual(['auth', 'category', 'description', 'name', 'parameters', 'type']);
    }

    // An SDK trigger declares the scheme its credential actually uses; without it every one of them
    // reads as Composio-managed and a caller is sent to the wrong kind of connection.
    const scheme = (type: string): string | undefined =>
      (triggers.find((t) => t.type === type) as { authScheme?: { type?: string } } | undefined)?.authScheme
        ?.type;
    expect(scheme('stripe.new_customer')).toBe('apiKey');
    expect(scheme('rss.new_item')).toBe('none');
    // Composio rows are brokered, so they carry no scheme of ours to declare.
    expect(scheme('github.github_commit_event')).toBeUndefined();
    // SDK rows project the FULL authoring surface: label, inlined static options, default, sample.
    const airtable = triggers.find((t) => t.type === 'airtable.new_record') as {
      parameters: Record<string, { label?: string }>;
      sample?: Record<string, unknown>;
    };
    expect(airtable.parameters.baseId?.label).toBe('Base');
    expect(airtable.sample?.id).toBe('rec560UJdUtocSouk');
    const slack = triggers.find((t) => t.type === 'slack.new_channel') as {
      parameters: Record<string, { defaultValue?: unknown; options?: unknown[] }>;
    };
    expect(slack.parameters.types?.defaultValue).toBe('public_channel');
    expect(slack.parameters.types?.options).toHaveLength(2);
    const types = new Set(triggers.map((t) => t.type));
    expect(types.has('orchestr:schedule')).toBe(true); // native schedule
    // Native chat intake: a control trigger, no auth, presentational params only.
    const chat = triggers.find((t) => t.type === 'orchestr:chat');
    expect(chat?.name).toBe('Chat');
    expect(chat?.category).toBe('control');
    expect(chat?.auth).toBe('none');
    expect(Object.keys(chat?.parameters as Record<string, unknown>).sort()).toEqual([
      'greeting',
      'initialMessages',
      'placeholder',
    ]);
    expect(types.has('github.new_push')).toBe(true); // SDK registered webhook
    expect(types.has('github.new_issue')).toBe(true); // SDK registered webhook
    expect(types.has('github.new_pull_request')).toBe(true); // SDK registered webhook
    // The SDK polling rail needs no Composio key: rss/hackernews/http are no-auth.
    expect(types.has('rss.new_item')).toBe(true);
    expect(types.has('hackernews.new_story')).toBe(true);
    expect(types.has('http.new_item')).toBe(true);
    expect(triggers.find((t) => t.type === 'rss.new_item')?.auth).toBe('none');
    expect(triggers.find((t) => t.type === 'slack.new_channel')?.auth).toBe('connection');
    // The Composio-polled gmail trigger, self-described in the registry.
    const gmail = triggers.find((t) => t.type === 'gmail.gmail_new_email_received');
    expect(gmail?.name).toBe('New Email');
    expect(gmail?.auth).toBe('connection');
    // An unregistered trigger type is not offered.
    expect(types.has('rss.new-item')).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/activepieces/i);
  });
});
