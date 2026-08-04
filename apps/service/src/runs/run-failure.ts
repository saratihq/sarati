/** The structured payload a failed run's error carries, so the failure is debuggable without a second lookup (ADR 0052). */
export interface RunFailureDetails {
  /** The run's handle — `GET /api/runs/:run_id` reads the same run with its step outputs. */
  run_id: string;
  /** The node whose failure ended the run; null when nothing ran or every failure was tolerated. */
  failed_node_id: string | null;
  /** The per-step log as of the failure, payloads withheld. */
  steps: Array<Record<string, unknown>>;
}

/** The node whose failure ended the run — a tolerated (continue-on-fail, ADR 0020) error is not it. */
export function failedNodeIdOf(steps: ReadonlyArray<Record<string, unknown>>): string | null {
  const failed = steps.find((s) => s.status === 'error' && s.continued !== true);
  return typeof failed?.node_id === 'string' ? failed.node_id : null;
}
