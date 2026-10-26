import { request } from 'undici';

export interface ClerkProfile {
  primary_email_address_id?: string | null;
  email_addresses?: Array<{
    id?: string;
    email_address?: string;
    verification?: { status?: string } | null;
  }>;
  first_name?: string | null;
  last_name?: string | null;
}

/** What a first Clerk sign-in records about the user. */
export interface ClerkIdentity {
  email: string;
  name: string;
  /** True only for the primary address Clerk verified — the one email that may link an existing account, by its password. */
  canLink: boolean;
}

/** Backend-API profile fetch — used once, at first provisioning. */
export async function fetchClerkUser(
  apiUrl: string,
  clerkUserId: string,
  secretKey: string,
): Promise<ClerkProfile> {
  const res = await request(`${apiUrl}/v1/users/${clerkUserId}`, {
    headers: { authorization: `Bearer ${secretKey}` },
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
  });
  if (res.statusCode >= 400) {
    await res.body.dump();
    throw new Error(`Clerk profile fetch failed with status ${res.statusCode}`);
  }
  return (await res.body.json()) as ClerkProfile;
}

/** The verified primary email, else the first verified one, else a placeholder — plus a display name. */
export function profileToIdentity(profile: ClerkProfile, clerkUserId: string): ClerkIdentity {
  const verified = (profile.email_addresses ?? []).filter(
    (entry) => entry.verification?.status === 'verified' && entry.email_address,
  );
  const primaryId = profile.primary_email_address_id;
  const primary =
    typeof primaryId === 'string' ? verified.find((entry) => entry.id === primaryId) : undefined;
  const email = (primary ?? verified[0])?.email_address ?? placeholderEmail(clerkUserId);

  const first = (profile.first_name ?? '').trim();
  const last = (profile.last_name ?? '').trim();
  const name = `${first} ${last}`.trim() || email.split('@')[0] || clerkUserId;
  return { email, name, canLink: primary !== undefined };
}

/** Placeholder identity when the profile fetch fails — never lock a verified session out, never link. */
export function placeholderIdentity(clerkUserId: string): ClerkIdentity {
  return { email: placeholderEmail(clerkUserId), name: clerkUserId, canLink: false };
}

function placeholderEmail(clerkUserId: string): string {
  return `${clerkUserId}@users.clerk.local`;
}
