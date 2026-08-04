// ─── Build-time public config (single source of truth) ───
// `NEXT_PUBLIC_*` values are INLINED by `next build`, so an unset var would silently ship the dev
// fallback to production — hence the fail-loud throw here rather than a default.
// Each var MUST be referenced as a full `process.env.NEXT_PUBLIC_*` literal for Next's static
// replacement to work, which is why the raw value is passed in rather than looked up by name.

const isProd = process.env.NODE_ENV === "production";

/**
 * Opt into relative URLs, for a deployment that serves the UI and the API from ONE origin (the
 * Docker image behind its reverse proxy). A published image cannot bake in an absolute URL — it would
 * freeze every install to whatever host it was built on — and this is spelled rather than inferred
 * from an empty value so a genuinely missing var still fails loud.
 */
const SAME_ORIGIN = "same-origin";

function resolvePublicUrl(name: string, raw: string | undefined, devFallback: string): string {
  const value = raw?.trim();
  if (value === SAME_ORIGIN) return "";
  if (value) return value.replace(/\/+$/, "");
  if (isProd) {
    throw new Error(
      `[config] ${name} must be set at build time for a production build. ` +
        `NEXT_PUBLIC_* values are inlined by \`next build\`, so leaving it unset ` +
        `would silently ship "${devFallback}" to production. Set ${name} and rebuild.`,
    );
  }
  return devFallback;
}

/** workflow-service origin (no trailing "/api" — callers append it). */
export const apiBaseUrl = resolvePublicUrl(
  "NEXT_PUBLIC_API_URL",
  process.env.NEXT_PUBLIC_API_URL,
  "http://localhost:8001",
);

/** agent-service origin (the AI composer). Dev: :8010. */
export const agentBaseUrl = resolvePublicUrl(
  "NEXT_PUBLIC_AGENT_URL",
  process.env.NEXT_PUBLIC_AGENT_URL,
  "http://localhost:8010",
);

// Optional, unlike the URLs above: an absent key is a real deployment (self-host signs in with
// email + password, ADR 0054), not a misconfiguration, so it must not fail the production build.
export const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? "";

/** Whether this build can run Clerk flows at all — false on a local-credential self-host. */
export const clerkEnabled = clerkPublishableKey !== "";
