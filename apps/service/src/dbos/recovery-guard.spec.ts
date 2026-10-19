import type { CheckpointedRun, RecordedOp } from '../runtime/recovery-exposure';
import { checkpointedRun, readResumability, type AppReads, type Sql } from './recovery-guard';

const run: CheckpointedRun = {
  plan: { id: 'p', nodes: [{ kind: 'action', id: 'a', actionId: 'act.x', props: {}, guards: [] }] },
  pins: {},
  initialScope: {},
};
const answering =
  (rows: Record<string, Array<Record<string, unknown>>>): Sql =>
  (text) => {
    const table = Object.keys(rows).find((name) => text.includes(name));
    if (!table) throw new Error(`unexpected read: ${text}`);
    return Promise.resolve(rows[table]!);
  };
const reads =
  (app: Sql): AppReads =>
  (read) =>
    read(app);
const recorded =
  (...ops: RecordedOp[]) =>
  (): Promise<RecordedOp[]> =>
    Promise.resolve(ops);

describe('readResumability', () => {
  it('resumes a workflow that recorded no op without opening the app database', async () => {
    const app: AppReads = () => Promise.reject(new Error('opened the app database'));
    expect(await readResumability(app, recorded(), 'u:r', run)).toEqual({ resumable: true });
  });

  it('refuses a workflow that recorded ops but whose run has no row', async () => {
    expect(
      await readResumability(
        reads(answering({ runtime_runs: [], runtime_run_steps: [] })),
        recorded({ name: 'p:a' }),
        'u:r',
        run,
      ),
    ).toEqual({ resumable: false, cause: 'unmatched', reason: 'it has no run row' });
  });

  it('judges a workflow that recorded ops on its steps and ops', async () => {
    expect(
      await readResumability(
        reads(
          answering({
            runtime_runs: [{ '?column?': 1 }],
            runtime_run_steps: [{ step_key: 'a', kind: 'action', pinned: false }],
          }),
        ),
        recorded({ name: 'p:a', output: { output: 1 }, failed: false }),
        'u:r',
        run,
      ),
    ).toEqual({ resumable: true });
  });
});

describe('checkpointedRun', () => {
  it('reads the plan, the pins and the scope a legacy workflow checkpointed, and refuses one with no plan', () => {
    expect(checkpointedRun([{ plan: run.plan, pins: { a: 1 }, initialScope: { trigger: {} } }])).toEqual({
      plan: run.plan,
      pins: { a: 1 },
      initialScope: { trigger: {} },
    });
    expect(checkpointedRun([{ plan: run.plan }])).toEqual(run);
    expect(() => checkpointedRun([{}])).toThrow('the workflow checkpointed no plan');
  });
});
