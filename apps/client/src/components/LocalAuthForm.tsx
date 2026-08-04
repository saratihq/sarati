"use client";

import { useState } from "react";
import * as api from "@/api/client";
import { MIN_PASSWORD_LENGTH } from "@/api/client";
import { Button } from "@/components/ui/button";

const INPUT_STYLE = {
  background: "var(--orchestr-accent-tint)",
  border: "1px solid var(--orchestr-line)",
  color: "var(--orchestr-ink)",
} as const;

export interface LocalAuthFormProps {
  /** `register` creates the account (first-run or invite); `signin` authenticates an existing one. */
  kind: "signin" | "register";
  /** Register against this org invite; omit for the instance's first account. */
  inviteToken?: string;
  submitLabel: string;
  /** Runs after the session is stored — navigate from here. */
  onDone: (user: api.AuthUser) => void | Promise<void>;
}

/** Email + password form for local auth (ADR 0054), used by the sign-in screen and the join page. */
export function LocalAuthForm({ kind, inviteToken, submitLabel, onDone }: LocalAuthFormProps) {
  const registering = kind === "register";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const short = MIN_PASSWORD_LENGTH - password.length;
  const blocker = !email.trim()
    ? "Enter your email address"
    : !password
      ? "Enter your password"
      : registering && short > 0
        ? `Password needs ${short} more character${short === 1 ? "" : "s"}`
        : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocker || busy) return;
    setError(null);
    setBusy(true);
    try {
      const { user } = registering
        ? await api.localRegister({
            email: email.trim(),
            password,
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(inviteToken ? { invite_token: inviteToken } : {}),
          })
        : await api.localLogin(email.trim(), password);
      await onDone(user);
    } catch (err) {
      // The service's `detail` — for a bad sign-in it deliberately never says WHICH field was wrong.
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {registering && (
        <div>
          <label htmlFor="local-name" className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
            Name
          </label>
          <input
            id="local-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
            style={INPUT_STYLE}
            placeholder="Your name"
          />
        </div>
      )}

      <div>
        <label htmlFor="local-email" className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
          Email
        </label>
        <input
          id="local-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
          autoComplete={registering ? "email" : "username"}
          className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
          style={INPUT_STYLE}
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label htmlFor="local-password" className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
          Password
        </label>
        <input
          id="local-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={registering ? MIN_PASSWORD_LENGTH : undefined}
          autoComplete={registering ? "new-password" : "current-password"}
          aria-describedby={registering ? "local-password-hint" : undefined}
          className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
          style={INPUT_STYLE}
          placeholder={registering ? `At least ${MIN_PASSWORD_LENGTH} characters` : "Enter your password"}
        />
        {registering && (
          <p
            id="local-password-hint"
            className="text-[11px] mt-1.5 m-0"
            style={{ color: short > 0 ? "var(--orchestr-ink-subtle)" : "var(--orchestr-success)" }}
          >
            {short > 0
              ? `At least ${MIN_PASSWORD_LENGTH} characters — length beats symbols.`
              : "Long enough."}
          </p>
        )}
      </div>

      {error && (
        <p className="text-xs m-0" role="alert" style={{ color: "var(--orchestr-danger)" }}>
          {error}
        </p>
      )}

      <div>
        <Button type="submit" variant="ai" disabled={Boolean(blocker) || busy} className="w-full">
          {busy ? `${submitLabel}...` : submitLabel}
        </Button>
        {blocker && (
          <p className="text-[11px] mt-1.5 m-0 text-center" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {blocker}
          </p>
        )}
      </div>
    </form>
  );
}
