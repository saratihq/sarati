import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Code node end-to-end over HTTP: compile the TS, then run it in the CodeRunner WASM sandbox. */
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

  const irNode = (id: string, node_type: string, parameters: Record<string, unknown>) => ({
    id,
    name: id,
    node_type,
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  });
  const codeNode = (id: string, parameters: Record<string, unknown>) =>
    irNode(id, 'orchestr:code', parameters);
  const irOf = (name: string, nodes: unknown[], edges: unknown[] = []) => ({
    version: '1',
    name,
    description: '',
    nodes,
    edges,
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  });
  const runIr = (workflow_ir: unknown, trigger_payload?: unknown) =>
    request(app.getHttpServer()).post('/api/runs/from-ir').send({ workflow_ir, trigger_payload });
  const runTs = (id: string, code: string, trigger_payload?: unknown) =>
    runIr(irOf(`code-ts-${id}`, [codeNode(id, { language: 'ts', code })]), trigger_payload);

  it('runs a JS snippet that transforms the trigger payload and feeds a downstream ref', async () => {
    const workflow_ir = irOf('code-js', [
      codeNode('total', {
        language: 'js',
        code: 'return { sum: trigger.items.reduce((a, b) => a + b, 0), count: trigger.items.length };',
      }),
    ]);
    const res = await runIr(workflow_ir, { items: [10, 20, 12] }).expect(201);
    expect(res.body.outputs.total).toEqual({ sum: 42, count: 3 });
  });

  it('transpiles + runs a TypeScript snippet in the sandbox', async () => {
    const res = await runTs(
      'shape',
      'const label: string = trigger.name as string; return { greeting: `hi ${label}` };',
      { name: 'ada' },
    ).expect(201);
    expect(res.body.outputs.shape).toEqual({ greeting: 'hi ada' });
  });

  it('a TypeScript snippet may await and return, as the async function body it runs as', async () => {
    const code = [
      'const seen: number[] = [];',
      'for await (const v of [Promise.resolve(1), 2]) seen.push(v);',
      'const r: number = await Promise.resolve(trigger.n as number);',
      'return { doubled: r * 2, seen };',
    ].join('\n');
    const res = await runTs('dbl', code, { n: 21 });
    expect(res.body).toMatchObject({ outputs: { dbl: { doubled: 42, seen: [1, 2] } } });
    expect(res.status).toBe(201);
  });

  it('a TypeScript snippet that awaits and returns saves through the commit door', async () => {
    const trigger = irNode('trigger', 'orchestr:trigger', {});
    const edge = {
      id: 'e1',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'calc',
      target_port: 0,
      port_type: 'main',
    };
    const withCode = (language: string, code: string) =>
      irOf('code-ts-commit', [trigger, codeNode('calc', { language, code })], [edge]);
    const dep = await request(app.getHttpServer())
      .post('/api/deploy')
      .send({ workflow_json: withCode('js', 'return 1;') })
      .expect(201);
    const saved = await request(app.getHttpServer())
      .post(`/api/workflows/${dep.body.workflow_id as string}/commit`)
      .send({ workflow_ir: withCode('ts', 'const r: number = await Promise.resolve(2); return r * 2;') });
    expect(saved.body).not.toHaveProperty('detail');
    expect(saved.status).toBe(201);
  });

  it('TypeScript is type-stripped, not type-checked: a type error compiles and runs as JS', async () => {
    const res = await runTs('loose', 'const n: number = "y"; return { n, kind: typeof n };').expect(201);
    expect(res.body.outputs.loose).toEqual({ n: 'y', kind: 'string' });
  });

  it("a TS syntax error is refused before any step runs, at the snippet's own line and column", async () => {
    const res = await runTs('bad', 'const total = 1;\nconst note = "café"; const x: = total;').expect(400);
    expect(res.body.code).toBe('compile_failed');
    expect(res.body.detail).toContain(
      'Code node "bad" has a TypeScript syntax error at line 2, column 31: Unexpected "="',
    );
  });

  it('an unclosed TypeScript snippet is refused at its end, not at a line it does not have', async () => {
    const res = await runTs('open', 'if (trigger) {\n  return 1;').expect(400);
    expect(res.body.detail).toContain(
      'Code node "open" has a TypeScript syntax error at the end of the snippet: Unexpected end of file',
    );
  });

  it('a snippet that throws fails the run with a clean sandbox error (no raw host trace)', async () => {
    const workflow_ir = irOf('code-throw', [codeNode('boom', { code: 'throw new Error("intentional");' })]);
    const res = await runIr(workflow_ir).expect(400);
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
