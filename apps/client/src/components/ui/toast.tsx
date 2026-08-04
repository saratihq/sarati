"use client";

import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { useToasts, type ToastKind } from "@/lib/toast";

// Renders the toast stack; state and the `toast.*` helpers live in lib/toast.ts.

const KIND_STYLE: Record<ToastKind, { color: string; tint: string; Icon: typeof Info }> = {
  success: { color: "var(--orchestr-success)", tint: "var(--orchestr-success-tint)", Icon: CheckCircle2 },
  error: { color: "var(--orchestr-danger)", tint: "var(--orchestr-danger-tint)", Icon: AlertTriangle },
  info: { color: "var(--orchestr-ink-muted)", tint: "var(--orchestr-accent-tint)", Icon: Info },
  warning: { color: "var(--orchestr-warning)", tint: "var(--orchestr-warning-tint)", Icon: AlertTriangle },
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div className="fixed bottom-5 right-5 z-[400] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-40px)]">
      <AnimatePresence>
        {toasts.map(({ id, kind, title, description, action }) => {
          const { color, tint, Icon } = KIND_STYLE[kind];
          return (
            <motion.div
              key={id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              role={kind === "error" ? "alert" : "status"}
              className="flex items-start gap-3 rounded-xl p-3.5 pr-2.5"
              style={{
                background: "var(--orchestr-surface-raised)",
                border: "1px solid var(--orchestr-line-strong)",
                boxShadow: "0 8px 32px rgba(0, 0, 0, 0.45)",
              }}
            >
              <span
                className="flex items-center justify-center rounded-full shrink-0"
                style={{ width: 28, height: 28, background: tint }}
              >
                <Icon size={15} style={{ color }} />
              </span>
              <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-[13px] font-medium leading-snug" style={{ color: "var(--orchestr-ink)" }}>
                  {title}
                </p>
                {description && (
                  <p className="text-xs mt-0.5 leading-snug" style={{ color: "var(--orchestr-ink-muted)" }}>
                    {description}
                  </p>
                )}
              </div>
              {action && (
                <button
                  onClick={action.onClick}
                  className="shrink-0 self-center text-xs font-semibold py-1 px-2.5 rounded-lg cursor-pointer bg-transparent hover:bg-[var(--orchestr-accent-tint)]"
                  style={{ border: "1px solid var(--orchestr-line-strong)", color: "var(--orchestr-ink)" }}
                >
                  {action.label}
                </button>
              )}
              <button
                onClick={() => dismiss(id)}
                aria-label="Dismiss notification"
                className="p-1 rounded-md cursor-pointer bg-transparent border-none hover:bg-[var(--orchestr-accent-tint)]"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                <X size={14} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}