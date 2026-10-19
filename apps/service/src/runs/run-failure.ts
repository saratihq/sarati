/** The structured payload a failed run's error carries, so the failure is debuggable without a second lookup. */
export interface RunFailureDetails {
  /** The run's handle — `GET /api/runs/:run_id` reads the same run with its step outputs. */
  run_id: string;
  /** The node whose failure ended the run; null when nothing ran or every failure was tolerated. */
  failed_node_id: string | null;
  /** The per-step log as of the failure, payloads withheld. */
  steps: Array<Record<string, unknown>>;
}

/** What a step reads that was under way when its run was ended for being unsafe to resume: it did not fail itself. */
export const NOT_RESUMED_STEP_ERROR = "Stopped when the service did — the run can't be resumed safely";

/** The node whose failure ended the run — a tolerated (continue-on-fail) error is not it, nor a step its run's end stopped. */
export function failedNodeIdOf(steps: ReadonlyArray<Record<string, unknown>>): string | null {
  const failed = steps.find(
    (s) => s.status === 'error' && s.continued !== true && s.error !== NOT_RESUMED_STEP_ERROR,
  );
  return typeof failed?.node_id === 'string' ? failed.node_id : null;
}
