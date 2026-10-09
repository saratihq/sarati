import Link from "next/link";
import type { RunWaiting } from "@/api/client";
import { formatDateTime } from "@/lib/format";

/** A waiting run's headline: a timer says when it wakes (or was due), and only an event wait asks for a decision. */
export function waitingLabel(waiting: RunWaiting | null | undefined): string {
  if (waiting?.kind === "timer") {
    const when = formatDateTime(waiting.until);
    return Date.parse(waiting.until ?? "") <= Date.now() ? `Was due at ${when}` : `Waiting until ${when}`;
  }
  if (waiting?.kind === "event") return "Waiting for a decision";
  return "Waiting";
}

/** What a waiting run needs next: an event wait is answered from the approvals inbox, a timer needs nothing. */
export default function RunWaitingNote({ waiting }: { waiting: RunWaiting }) {
  if (waiting.kind === "timer") return <>Paused on a Wait step — it resumes on its own.</>;
  return (
    <>
      Paused on an approval step —{" "}
      <Link href="/approvals" className="underline underline-offset-2" style={{ color: "var(--orchestr-ink)" }}>
        open the approvals inbox
      </Link>
      .
    </>
  );
}
