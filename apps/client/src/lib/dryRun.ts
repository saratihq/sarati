import { formatDuration } from "@/lib/format";

// The ONE reading of what a dry run leaves in place of a step's output; the service writes it
// (providers/dry-run-marker.ts) and every surface that shows a dry run reads it here.

/** What a dry run does and does not do — the rule, in the words every surface shares. */
export const DRY_RUN_EXPLAINED =
  "Reads run for real. Writes (POST, PUT, PATCH, DELETE) are not sent, waits are skipped, and steps on a managed connection are not run.";

/** The marker a dry run records for a step it did not carry out. */
export interface DryRunMarker {
  dry_run: true;
  /** Absent on runs recorded before the service named the reason. */
  withheld?: "write" | "managed_step" | "delay" | "wait";
  skipped?: string;
  would_call?: Array<{ method: string; url: string }>;
  skipped_delay_ms?: number;
}

/** The marker on a step's output, or null when the step was carried out. */
export function dryRunMarkerOf(output: unknown): DryRunMarker | null {
  if (output === null || typeof output !== "object") return null;
  return (output as { dry_run?: unknown }).dry_run === true ? (output as DryRunMarker) : null;
}

/** One line saying what the dry run did instead of carrying the step out. */
export function withheldSummary(marker: DryRunMarker): string {
  const calls = marker.would_call ?? [];
  if (marker.withheld === "write" || calls.length > 0) {
    const listed = calls.map((c) => `${c.method} ${c.url}`).join(", ");
    return listed ? `Not sent — would call ${listed}` : "Not sent";
  }
  if (marker.withheld === "delay" || typeof marker.skipped_delay_ms === "number") {
    return `Wait skipped — ${formatDuration(marker.skipped_delay_ms)}`;
  }
  if (marker.withheld === "wait") return "Not waited for — a dry run does not pause for an event";
  if (marker.withheld === "managed_step") {
    return "Not run — a dry run does not run steps on a managed connection";
  }
  return marker.skipped ? `Not run — ${marker.skipped}` : "Not run";
}
