"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

// `hydrated` gates the first render: the chosen theme exists only in the browser,
// so SSR must paint nothing selected rather than guess and flip.
const NEVER_CHANGES = () => () => {};

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false,
  );

  return (
    <div
      className="rounded-lg p-5"
      style={{
        background: "var(--orchestr-surface-card)",
        border: "1px solid var(--orchestr-line)",
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-[var(--orchestr-ink)]">Theme</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
            System follows your device appearance.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Theme"
          className="flex items-center gap-1 rounded-lg p-1"
          style={{ background: "var(--orchestr-surface)" }}
        >
          {OPTIONS.map(({ value, label, Icon }) => {
            const selected = hydrated && theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(value)}
                title={label}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orchestr-ai)]"
                style={{
                  background: selected ? "var(--orchestr-surface-card)" : "transparent",
                  color: selected ? "var(--orchestr-ink)" : "var(--orchestr-ink-muted)",
                  border: `1px solid ${selected ? "var(--orchestr-line)" : "transparent"}`,
                }}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
