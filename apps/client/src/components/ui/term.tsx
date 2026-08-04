import type { ReactNode } from "react";

// Plain-words glossary for the version-control vocabulary — keep entries SHORT
// and in the user's language: automation builders, not git experts.
export const GLOSSARY = {
  branch: "A separate line of versions for trying changes without touching main.",
  tag: "A label on a version (prod, uat, staging, dev). Read-only — every workflow runs natively on Sarati.",
  fork: "The version this branch started from.",
  sync: "Copies the live deployment back into Sarati as a new version. (The opposite direction of deploying.)",
  deploy: "Pushes this version live to the environment. The deployment keeps the same webhook URLs.",
  engine: "Where an automation runs — Sarati's own runtime.",
  merge: "Applies a branch's changes onto the target branch as new versions.",
  save: "Records your edits as a new version. It does NOT change what runs — Publish does that.",
  publish: "Makes a version live. Runs and triggers start using it immediately. This is the release step.",
  restore: "Rolls the live version back to an earlier one — instantly, without creating a new version.",
  live: "The version running right now. Saving new versions never changes this until you Publish.",
} as const;

/** Styled hover/focus tooltip around any element: <Tooltip content={GLOSSARY.tag}>…</Tooltip> */
export function Tooltip({
  content,
  children,
  block = false,
}: {
  content: ReactNode;
  children: ReactNode;
  /** Render as a block wrapper (for inputs/selects) instead of inline. */
  block?: boolean;
}) {
  return (
    <span className={`relative group ${block ? "block" : "inline-flex"}`}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 w-max max-w-[260px] rounded-lg px-3 py-2 text-[11px] leading-snug normal-case font-normal tracking-normal text-left opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150 delay-100 z-[250]"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          color: "var(--orchestr-ink-muted)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
        }}
      >
        {content}
      </span>
    </span>
  );
}
