/** The pluggable-auth seam (ADR 0002): each verifier turns a bearer token into an identity claim, tried in order. */
export interface VerifiedIdentity {
  /** External auth subject (Clerk `sub`, or an OIDC `sub`) → users.clerk_user_id. */
  clerkUserId?: string;
  /** A pre-resolved local user id (e.g. an API key already identifies its owner). */
  userId?: string;
  /** Token-carried profile claims; when present the user is provisioned from them, with no profile fetch. */
  email?: string;
  name?: string;
  /** Set only by the API-key verifier — its presence marks the caller as a key, not a session. */
  apiKey?: { scopes: string[] | null; orgId: string | null };
}

export interface TokenVerifier {
  readonly name: string;
  /** Returns identity, or null when this verifier doesn't handle the token shape.
   *  Throws TokenExpiredError / InvalidTokenError for tokens it owns but rejects. */
  verify(token: string): Promise<VerifiedIdentity | null>;
}

export const TOKEN_VERIFIERS = Symbol('TOKEN_VERIFIERS');
