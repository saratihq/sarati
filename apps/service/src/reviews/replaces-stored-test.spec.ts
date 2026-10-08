import type { ReviewTestSummary } from './review-test.types';
import { replacesStoredTest } from './review-test.service';

const of = (source: string, target: string): ReviewTestSummary => ({
  verdict: 'red',
  tested_at: '2026-10-08T10:00:00.000Z',
  environment_id: null,
  source_version_id: source,
  target_version_id: target,
  base: { run_id: 'b', status: 'completed', error: null },
  head: { run_id: 'h', status: 'error', error: 'boom' },
  regression: { changed: [], added: [], removed: [] },
});
const HEADS = { source: 's1', target: 't1' };

describe('replacesStoredTest — a slow test of older heads must not erase the current one', () => {
  it('keeps a stored test of the current heads when a test of older heads finishes after it', () => {
    expect(replacesStoredTest(of('s1', 't1'), of('s0', 't1'), HEADS)).toBe(false);
  });

  it('keeps a decisive test of the current heads against one where the target failed too', () => {
    const bothFailed: ReviewTestSummary = {
      ...of('s1', 't1'),
      verdict: 'green',
      base: { run_id: 'b', status: 'error', error: 'down' },
    };
    expect(replacesStoredTest(of('s1', 't1'), bothFailed, HEADS)).toBe(false);
    expect(replacesStoredTest(bothFailed, of('s1', 't1'), HEADS)).toBe(true);
  });

  it('stores any test of the current heads, and any test over a stale or missing one', () => {
    expect(replacesStoredTest(of('s1', 't1'), of('s1', 't1'), HEADS)).toBe(true);
    expect(replacesStoredTest(of('s0', 't1'), of('s0', 't0'), HEADS)).toBe(true);
    expect(replacesStoredTest(null, of('s0', 't1'), HEADS)).toBe(true);
  });
});
