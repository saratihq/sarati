import type { SkippedRequest } from './dry-run-http-client';

/** Why a dry run did not carry a step out. */
export type WithheldReason = 'write' | 'managed_step' | 'delay' | 'wait';

/** What a dry run records in place of the output of a step it did not carry out. */
export interface DryRunMarker {
  dry_run: true;
  withheld: WithheldReason;
  /** The same reason in words, for a reader without the codes. */
  skipped?: string;
  /** The state-changing requests the step would have made, in order. */
  would_call?: Array<{ method: string; url: string }>;
  skipped_delay_ms?: number;
}

/** A step that stopped at a state-changing request. */
export function withheldWrite(requests: readonly SkippedRequest[]): DryRunMarker {
  return {
    dry_run: true,
    withheld: 'write',
    skipped: 'state-changing request (not sent in a dry run)',
    would_call: requests.map(({ method, url }) => ({ method, url })),
  };
}

/** A step on a managed connection: it executes on the broker's side, so there is no request to withhold. */
export function withheldManagedStep(): DryRunMarker {
  return {
    dry_run: true,
    withheld: 'managed_step',
    skipped: 'composio typed execution (not simulated in a dry run)',
  };
}

export function withheldDelay(ms: number): DryRunMarker {
  return { dry_run: true, withheld: 'delay', skipped_delay_ms: ms };
}

export function withheldWait(): DryRunMarker {
  return { dry_run: true, withheld: 'wait', skipped: 'wait-for-event (dry run)' };
}
