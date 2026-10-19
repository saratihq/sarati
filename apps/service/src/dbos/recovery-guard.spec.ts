import type { DagPlan } from '../runtime/dag-plan';
import { readResumability, type Sql } from './recovery-guard';

const plan: DagPlan = {
  id: 'p',
  nodes: [{ kind: 'action', id: 'a', actionId: 'act.x', props: {}, guards: [] }],
};
const answering =
  (rows: Record<string, Array<Record<string, unknown>>>): Sql =>
  (text) => {
    const table = Object.keys(rows).find((name) => text.includes(name));
    if (!table) throw new Error(`unexpected read: ${text}`);
    return Promise.resolve(rows[table]!);
  };

describe('readResumability', () => {
  it('resumes a workflow that recorded no op, whatever the app database holds', async () => {
    const app: Sql = () => Promise.reject(new Error('read the app database'));
    expect(await readResumability(app, answering({ operation_outputs: [] }), 'u:r', plan)).toEqual({
      resumable: true,
    });
  });

  it('refuses a workflow that recorded ops but whose run has no row', async () => {
    expect(
      await readResumability(
        answering({ runtime_runs: [], runtime_run_steps: [] }),
        answering({ operation_outputs: [{ function_name: 'p:a' }] }),
        'u:r',
        plan,
      ),
    ).toEqual({ resumable: false, cause: 'unmatched', reason: 'it has no run row' });
  });

  it('judges a workflow that recorded ops on its steps and ops', async () => {
    expect(
      await readResumability(
        answering({
          runtime_runs: [{ '?column?': 1 }],
          runtime_run_steps: [{ step_key: 'a', kind: 'action', pinned: false }],
        }),
        answering({ operation_outputs: [{ function_name: 'p:a' }] }),
        'u:r',
        plan,
      ),
    ).toEqual({ resumable: true });
  });
});
