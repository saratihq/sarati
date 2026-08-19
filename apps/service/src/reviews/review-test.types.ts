/** Shapes for pre-merge "Test this branch", stored on `workflow_reviews.last_test`. */

export type TestVerdict = 'green' | 'red';

/** One field-level difference between the two runs' outputs. */
export interface RunOutputChange {
  /** The node whose output differs. */
  node_id: string;
  /** Dotted path within that node's output (`body.text`, `rows[0].id`, or `(value)` for a scalar). */
  path: string;
  /** Value on the target-branch (baseline) side — truncated for storage. */
  before: unknown;
  /** Value on the source-branch (changed) side — truncated for storage. */
  after: unknown;
  /** Set when this row collapses a contiguous run of added/removed array entries: how many. */
  count?: number;
}

/** The field-level output regression of the source branch vs the target baseline. */
export interface RunOutputRegression {
  /** Fields whose value changed in a node present on both sides. */
  changed: RunOutputChange[];
  /** Node ids that produced output only on the source (changed) side. */
  added: string[];
  /** Node ids that produced output only on the target (baseline) side. */
  removed: string[];
}

/** One side (base or head) of a review test. */
export interface ReviewTestSide {
  run_id: string;
  status: 'completed' | 'error';
  /** The failure message when `status === 'error'`, else null. */
  error: string | null;
}

/** The review's latest pre-merge test; the gate ignores it as STALE once the version ids no longer match the branch heads. */
export interface ReviewTestSummary {
  verdict: TestVerdict;
  tested_at: string;
  environment_id: string | null;
  source_version_id: string | null;
  target_version_id: string | null;
  base: ReviewTestSide;
  head: ReviewTestSide;
  regression: RunOutputRegression;
}
