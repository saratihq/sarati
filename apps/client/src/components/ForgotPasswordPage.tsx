"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSignIn } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { clerkErrorMessage } from "@/lib/clerkErrors";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { SaratiSquircle } from "@/components/SaratiLogo";

const INPUT_STYLE = {
  background: "var(--orchestr-accent-tint)",
  border: "1px solid var(--orchestr-line)",
  color: "var(--orchestr-ink)",
} as const;

const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Headless Clerk reset_password_email_code flow. Must use create({identifier}) + prepareFirstFactor,
 * not the create({strategy}) shorthand, which can leave the client-side verification unprepared.
 */
export default function ForgotPasswordPage() {
  useDocumentTitle("Reset password");
  const router = useRouter();
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resendWait, setResendWait] = useState(0);

  const startResendCooldown = () => {
    setResendWait(RESEND_COOLDOWN_SECONDS);
    const timer = setInterval(() => {
      setResendWait((s) => {
        if (s <= 1) {
          clearInterval(timer);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  // Sends (or resends) the emailed code; false when the email has no reset-code factor.
  const prepareResetCode = async (): Promise<boolean> => {
    if (!isLoaded || !signIn) return false;
    const factor = signIn.supportedFirstFactors?.find((f) => f.strategy === "reset_password_email_code");
    if (!factor || !("emailAddressId" in factor)) {
      // No reset factor is almost always an SSO-only account.
      setError("This account signs in with Google or GitHub — use that button on the sign-in page.");
      return false;
    }
    await signIn.prepareFirstFactor({
      strategy: "reset_password_email_code",
      emailAddressId: factor.emailAddressId,
    });
    startResendCooldown();
    return true;
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded || loading) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await signIn.create({ identifier: email });
      if (await prepareResetCode()) {
        setCodeSent(true);
      }
    } catch (err) {
      setError(clerkErrorMessage(err, "Couldn't send the reset code"));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!isLoaded || loading || resendWait > 0) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      if (await prepareResetCode()) {
        setCode("");
        setNotice("New code sent — check your email");
      }
    } catch (err) {
      setError(clerkErrorMessage(err, "Couldn't resend the code"));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded || loading) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const attempt = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code: code.trim(),
      });
      if (attempt.status !== "needs_new_password" && attempt.status !== "complete") {
        setError("Verification incomplete — try the code again");
        return;
      }
      const result =
        attempt.status === "complete"
          ? attempt
          : await signIn.resetPassword({ password, signOutOfOtherSessions: true });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/");
      } else {
        setError("Additional verification required — contact support");
      }
    } catch (err) {
      // A stale attempt (expired verification, resumed tab) recovers by sending a fresh code.
      const maybeClerk = err as { errors?: Array<{ code?: string }> };
      const codeName = maybeClerk.errors?.[0]?.code || "";
      if (codeName.includes("verification") && codeName !== "form_code_incorrect") {
        try {
          if (await prepareResetCode()) {
            setCode("");
            setNotice("That code expired — we emailed you a new one");
            return;
          }
        } catch {
          /* fall through to the original error */
        }
      }
      setError(clerkErrorMessage(err, "Password reset failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--orchestr-surface)" }}
    >
      <div
        className="w-full max-w-[380px] rounded-lg p-8"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line)",
        }}
      >
        <div className="mb-8 text-center">
          <div className="flex items-center justify-center mb-4">
            <SaratiSquircle size={48} />
          </div>
          <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--orchestr-ink)" }}>
            {codeSent ? "Check your email" : "Reset your password"}
          </h1>
          <p className="text-sm" style={{ color: "var(--orchestr-ink-muted)" }}>
            {codeSent ? `We sent a reset code to ${email}` : "We'll email you a reset code"}
          </p>
        </div>

        {codeSent ? (
          <form onSubmit={handleReset} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                Reset code
              </label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-full py-2.5 px-3 rounded-lg text-sm outline-none tracking-[0.3em] text-center"
                style={INPUT_STYLE}
                placeholder="123456"
              />
            </div>
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                New password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
                style={INPUT_STYLE}
                placeholder="At least 8 characters"
              />
            </div>

            {error && (
              <p className="text-xs" style={{ color: "var(--orchestr-danger)" }}>
                {error}
              </p>
            )}
            {notice && (
              <p className="text-xs" style={{ color: "var(--orchestr-success)" }}>
                {notice}
              </p>
            )}

            <Button type="submit" disabled={!isLoaded || loading || !code.trim() || !password} className="w-full">
              {loading ? "Resetting..." : "Reset password"}
            </Button>

            <div className="flex items-center justify-center gap-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResend}
                disabled={!isLoaded || loading || resendWait > 0}
              >
                {resendWait > 0 ? `Resend code (${resendWait}s)` : "Resend code"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setPassword("");
                  setError(null);
                  setNotice(null);
                }}
              >
                Use a different email
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSendCode} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
                style={INPUT_STYLE}
                placeholder="you@example.com"
              />
            </div>

            {error && (
              <p className="text-xs" style={{ color: "var(--orchestr-danger)" }}>
                {error}
              </p>
            )}

            <Button type="submit" disabled={!isLoaded || loading || !email.trim()} className="w-full">
              {loading ? "Sending code..." : "Send reset code"}
            </Button>
          </form>
        )}

        <p className="text-center text-xs mt-6" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Remembered it?{" "}
          <Link href="/login" className="hover:underline" style={{ color: "var(--orchestr-ink)" }}>
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
