"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSignUp } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { clerkErrorMessage } from "@/lib/clerkErrors";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useRedirectIfSignedIn } from "@/lib/useRedirectIfSignedIn";
import { SaratiSquircle } from "@/components/SaratiLogo";

type OAuthStrategy = "oauth_google" | "oauth_github";

const RESEND_COOLDOWN_SECONDS = 30;

const INPUT_STYLE = {
  background: "var(--orchestr-accent-tint)",
  border: "1px solid var(--orchestr-line)",
  color: "var(--orchestr-ink)",
} as const;

function GoogleGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z" />
    </svg>
  );
}

function GitHubGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.72.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.72-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.35 9.35 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.25 10.25 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

export default function SignupPage() {
  useDocumentTitle("Create account");
  const redirectingToApp = useRedirectIfSignedIn();
  const router = useRouter();
  const { isLoaded, signUp, setActive } = useSignUp();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
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

  const handleResend = async () => {
    if (!isLoaded || loading || resendWait > 0) return;
    setError(null);
    setNotice(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      startResendCooldown();
      setNotice("New code sent — check your email");
    } catch (err) {
      setError(clerkErrorMessage(err, "Couldn't resend the code"));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setError(null);
    setLoading(true);
    try {
      const result = await signUp.create({
        emailAddress: email,
        password,
        ...(name.trim() ? { firstName: name.trim() } : {}),
      });
      if (result.status === "complete") {
        // Instance doesn't require email verification — session is live.
        await setActive({ session: result.createdSessionId });
        router.push("/");
        return;
      }
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setPendingVerification(true);
      startResendCooldown();
    } catch (err) {
      setError(clerkErrorMessage(err, "Signup failed"));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded) return;
    setError(null);
    setLoading(true);
    try {
      const result = await signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/");
      } else {
        setError("Verification incomplete — try the code again");
      }
    } catch (err) {
      setError(clerkErrorMessage(err, "Invalid verification code"));
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = async (strategy: OAuthStrategy) => {
    if (!isLoaded) return;
    setError(null);
    try {
      await signUp.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/",
      });
    } catch (err) {
      setError(clerkErrorMessage(err, "Signup failed"));
    }
  };

  // Already authenticated: the redirect is in flight — don't flash the form.
  if (redirectingToApp) return null;

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
            {pendingVerification ? "Check your email" : "Create an account"}
          </h1>
          <p className="text-sm" style={{ color: "var(--orchestr-ink-muted)" }}>
            {pendingVerification
              ? `We sent a verification code to ${email}`
              : "Version control for your automations — branch, review, test, and deploy"}
          </p>
        </div>

        {pendingVerification ? (
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                Verification code
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

            <Button type="submit" disabled={!isLoaded || loading || !code.trim()} className="w-full">
              {loading ? "Verifying..." : "Verify email"}
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
                  setPendingVerification(false);
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
              >
                Use a different email
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-col gap-2 mb-5">
              <Button type="button" variant="secondary" onClick={() => handleOAuth("oauth_google")} className="w-full">
                <GoogleGlyph /> Continue with Google
              </Button>
              <Button type="button" variant="secondary" onClick={() => handleOAuth("oauth_github")} className="w-full">
                <GitHubGlyph /> Continue with GitHub
              </Button>
            </div>

            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px" style={{ background: "var(--orchestr-line)" }} />
              <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                or
              </span>
              <div className="flex-1 h-px" style={{ background: "var(--orchestr-line)" }} />
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
                  style={INPUT_STYLE}
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
                  style={INPUT_STYLE}
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
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

              {/* Clerk's bot-protection CAPTCHA mounts here when the instance
                  has it enabled; invisible otherwise. */}
              <div id="clerk-captcha" />

              <Button type="submit" disabled={!isLoaded || loading || !email.trim() || !password} className="w-full">
                {loading ? "Creating account..." : "Create account"}
              </Button>
            </form>
          </>
        )}

        {!pendingVerification && (
          <p className="text-center text-xs mt-6" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Already have an account?{" "}
            <Link href="/login" className="hover:underline" style={{ color: "var(--orchestr-ink)" }}>
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
