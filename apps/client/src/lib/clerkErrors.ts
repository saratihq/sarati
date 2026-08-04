// Friendlier copy for confusing Clerk error codes; anything unlisted falls back to Clerk's own message.
const FRIENDLY_MESSAGES: Record<string, string> = {
  // An OAuth-created account has no password credential, so "password" isn't a valid strategy for it.
  strategy_for_user_invalid:
    "This account signs in with Google or GitHub. Use one of those, or reset your password to add one.",
  form_password_incorrect: "Incorrect email or password.",
  form_identifier_not_found: "No account found for this email. Try signing up instead.",
  form_identifier_exists: "An account with this email already exists. Try signing in instead.",
};

type ClerkErrorShape = { errors?: Array<{ code?: string; longMessage?: string; message?: string }> };

export function clerkErrorMessage(err: unknown, fallback: string): string {
  const clerkError = (err as ClerkErrorShape)?.errors?.[0];
  if (clerkError?.code && FRIENDLY_MESSAGES[clerkError.code]) {
    return FRIENDLY_MESSAGES[clerkError.code];
  }
  return clerkError?.longMessage || clerkError?.message || fallback;
}
