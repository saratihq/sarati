import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

interface NestApp {
  init(): Promise<unknown>;
  listen(port: number, host: string): Promise<unknown>;
}
interface ModuleBuilder {
  overrideProvider(token: unknown): { useValue(value: unknown): ModuleBuilder };
  compile(): Promise<{ createNestApplication(options: object): NestApp }>;
}

// Asked for a turn, it calls the first tool it is offered with an id no other process gives, as a model does, or answers
// once it is offered none.
const toolEveryTurn = (): unknown => {
  const process = randomBytes(4).toString('hex');
  let turn = 0;
  return {
    call: (req: { tools: Array<{ name: string }> }) =>
      Promise.resolve(
        req.tools.length > 0
          ? {
              text: 'again',
              toolCalls: [{ id: `${process}c${turn++}`, name: req.tools[0]!.name, input: { q: 'x' } }],
            }
          : { text: 'done', toolCalls: [] },
      ),
  };
};

// The build at GOLDEN_R0 booted as its main.ts boots it, with a scripted model behind the agent node.
async function boot(root: string): Promise<void> {
  const from = <T>(path: string): Promise<T> => import(path) as Promise<T>;
  const { Test } = await from<{ Test: { createTestingModule(meta: object): ModuleBuilder } }>(
    require.resolve('@nestjs/testing', { paths: [root] }),
  );
  const { AppModule } = await from<{ AppModule: unknown }>(join(root, 'src/app.module'));
  const { configureApp } = await from<{ configureApp(app: NestApp): { port: number } }>(
    join(root, 'src/bootstrap'),
  );
  const { AGENT_MODEL_CALL } = await from<{ AGENT_MODEL_CALL: unknown }>(join(root, 'src/runtime/agent'));
  const { ScriptedAgentModel } = await from<{ ScriptedAgentModel: new (turns: unknown[]) => unknown }>(
    join(root, 'src/runtime/agent.testkit'),
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AGENT_MODEL_CALL)
    .useValue(
      process.env.GOLDEN_MODEL === 'tool-every-turn'
        ? toolEveryTurn()
        : new ScriptedAgentModel([
            { text: 'looking it up', toolCalls: [{ id: 'c1', name: 'lookup', input: {} }] },
            { text: 'found it', toolCalls: [] },
          ]),
    )
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
  const env = configureApp(app);
  await app.listen(env.port, '127.0.0.1');
}

void boot(process.env.GOLDEN_R0 ?? process.cwd());
