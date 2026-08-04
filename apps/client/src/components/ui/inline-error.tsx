"use client";

/** THE inline "this list failed to load" row — keeps a failure from reading as an empty collection. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg"
      style={{ background: "var(--orchestr-danger-tint)" }}
    >
      <span className="text-xs" style={{ color: "var(--orchestr-danger)" }}>
        {message}
      </span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-xs bg-transparent border-none cursor-pointer underline shrink-0"
          style={{ color: "var(--orchestr-ink)" }}
        >
          Retry
        </button>
      )}
    </div>
  );
}
