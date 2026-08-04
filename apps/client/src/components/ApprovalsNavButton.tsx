"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { useApprovals } from "@/store/useApprovals";

const BADGE_POLL_MS = 20_000;

// Header entry for the approvals inbox: badge counts runs waiting on a human (shared useApprovals store).
export default function ApprovalsNavButton() {
  const waiting = useApprovals((s) => s.waiting);
  const fetchWaiting = useApprovals((s) => s.fetchWaiting);

  useEffect(() => {
    fetchWaiting();
    const t = setInterval(fetchWaiting, BADGE_POLL_MS);
    return () => clearInterval(t);
  }, [fetchWaiting]);

  const count = waiting?.length ?? 0;

  return (
    <Link
      href="/approvals"
      aria-label={count > 0 ? `Approvals inbox — ${count} waiting` : "Approvals inbox"}
      className="relative flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-[var(--orchestr-accent-tint)]"
      style={{ color: "var(--orchestr-ink-muted)" }}
    >
      <Inbox size={15} />
      {count > 0 && (
        <span
          data-testid="approvals-badge"
          className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 rounded-full flex items-center justify-center text-[9px] font-bold leading-none"
          style={{ background: "var(--orchestr-warning)", color: "var(--orchestr-on-warning)" }}
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
