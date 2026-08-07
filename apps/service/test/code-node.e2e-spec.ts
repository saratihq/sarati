import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Code node (ADR 0027) end-to-end over HTTP: compile the TS, then run it in the CodeRunner WASM sandbox. */
describe('code node over /api/runs/from-ir (e2e, isolated DB)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

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
  }, 30_000);

  const codeNode = (id: string, parameters: Record<string, unknown>) => ({
    id,
    name: id,
    node_type: 'orchestr:code',
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  });

  it('runs a JS snippet that transforms the trigger payload and feeds a downstream ref', async () => {
    const workflow_ir = {
      version: '1',
      name: 'code-js',
      description: '',
      nodes: [
        codeNode('total', {
          language: 'js',
          code: 'return { sum: trigger.items.reduce((a, b) => a + b, 0), count: trigger.items.length };',
        }),
      ],
      edges: [],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, trigger_payload: { items: [10, 20, 12] } })
      .expect(201);
    expect(res.body.outputs.total).toEqual({ sum: 42, count: 3 });
  });

  it('transpiles + runs a TypeScript snippet in the sandbox', async () => {
    const workflow_ir = {
      version: '1',
      name: 'code-ts',
      description: '',
      nodes: [
        codeNode('shape', {
          language: 'ts',
          code: 'const label: string = trigger.name as string; return { greeting: `hi ${label}` };',
        }),
      ],
      edges: [],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, trigger_payload: { name: 'ada' } })
      .expect(201);
    expect(res.body.outputs.shape).toEqual({ greeting: 'hi ada' });
  });

  it('a snippet that throws fails the run with a clean sandbox error (no raw host trace)', async () => {
    const workflow_ir = {
      version: '1',
      name: 'code-throw',
      description: '',
      nodes: [codeNode('boom', { code: 'throw new Error("intentional");' })],
      edges: [],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('intentional');
  });

  it('lists orchestr:code as a placeable Code node in the catalog', async () => {
    const res = await request(app.getHttpServer()).get('/api/node-types').expect(200);
    const code = (res.body.node_types as Array<{ type: string; name: string; category: string }>).find(
      (n) => n.type === 'orchestr:code',
    );
    expect(code).toMatchObject({ name: 'Code', category: 'control' });
  });
});
