import type { ReviewTestSummary } from '../reviews/review-test.types';
import { latestFailingTest } from './branch.service';

const HEADS = { source: 's1', target: 't1' };
const test = (
  over: Partial<ReviewTestSummary> & Pick<ReviewTestSummary, 'verdict' | 'tested_at'>,
): ReviewTestSummary => ({
  environment_id: null,
  source_version_id: 's1',
  target_version_id: 't1',
  base: { run_id: 'b', status: 'completed', error: null },
  head: { run_id: 'h', status: over.verdict === 'red' ? 'error' : 'completed', error: null },
  regression: { changed: [], added: [], removed: [] },
  ...over,
});
const review = (id: string, lastTest: ReviewTestSummary | null) => ({ id, title: `review ${id}`, lastTest });

describe('latestFailingTest — what a protected merge refuses on (constitution #15)', () => {
  it('lets the newest test of these heads decide, whichever review ran it', () => {
    const red = review('a', test({ verdict: 'red', tested_at: '2026-10-08T10:00:00.000Z' }));
    const green = review('b', test({ verdict: 'green', tested_at: '2026-10-08T11:00:00.000Z' }));
    expect(latestFailingTest([red, green], HEADS)).toBeNull();
    const laterRed = review('c', test({ verdict: 'red', tested_at: '2026-10-08T12:00:00.000Z' }));
    expect(latestFailingTest([red, green, laterRed], HEADS)).toEqual({ id: 'c', title: 'review c' });
  });

  it('ignores a test of other heads, on either side', () => {
    const otherSource = review(
      'a',
      test({ verdict: 'red', tested_at: '2026-10-08T10:00:00.000Z', source_version_id: 's0' }),
    );
    const otherTarget = review(
      'b',
      test({ verdict: 'red', tested_at: '2026-10-08T10:00:00.000Z', target_version_id: 't0' }),
    );
    expect(latestFailingTest([otherSource, otherTarget], HEADS)).toBeNull();
  });

  it('lets a test where the target failed too decide nothing — it cannot lift a real failure', () => {
    const red = review('a', test({ verdict: 'red', tested_at: '2026-10-08T10:00:00.000Z' }));
    const bothFailed = review(
      'b',
      test({
        verdict: 'green',
        tested_at: '2026-10-08T11:00:00.000Z',
        base: { run_id: 'b', status: 'error', error: 'connection not found' },
        head: { run_id: 'h', status: 'error', error: 'connection not found' },
      }),
    );
    expect(latestFailingTest([red, bothFailed], HEADS)).toEqual({ id: 'a', title: 'review a' });
  });

  it('fails closed on a tie, and says nothing without a test', () => {
    const at = '2026-10-08T10:00:00.000Z';
    const green = review('a', test({ verdict: 'green', tested_at: at }));
    const red = review('b', test({ verdict: 'red', tested_at: at }));
    expect(latestFailingTest([green, red], HEADS)).toEqual({ id: 'b', title: 'review b' });
    expect(latestFailingTest([red, green], HEADS)).toEqual({ id: 'b', title: 'review b' });
    expect(latestFailingTest([review('c', null)], HEADS)).toBeNull();
  });
});
