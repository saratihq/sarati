import type { SaveWarning } from "@/api/client";
import { toast } from "@/lib/toast";

/** The save or merge went through — but say what the service flagged about what it wrote. */
export function warnSaved(title: string, warnings: readonly SaveWarning[] | undefined): void {
  const [first, ...rest] = warnings ?? [];
  if (!first) return;
  toast.warning(title, rest.length > 0 ? `${first.message} (+${rest.length} more)` : first.message);
}
