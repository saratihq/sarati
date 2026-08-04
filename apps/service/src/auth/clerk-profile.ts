import { request } from 'undici';

export interface ClerkProfile {
  primary_email_address_id?: string;
  email_addresses?: Array<{ id?: string; email_address?: string }>;
  first_name?: string | null;
  last_name?: string | null;
}

/** Backend-API profile fetch — used once, at first provisioning. */
export async function fetchClerkUser(clerkUserId: string, secretKey: string): Promise<ClerkProfile> {
  const res = await request(`https://api.clerk.com/v1/users/${clerkUserId}`, {
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

/** Primary email (else first, else placeholder) + a display name from first/last (else the email local-part). */
export function profileToIdentity(
  profile: ClerkProfile,
  clerkUserId: string,
): { email: string; name: string } {
  let email = '';
  const primaryId = profile.primary_email_address_id;
  for (const entry of profile.email_addresses ?? []) {
    if (entry.id === primaryId || !email) email = entry.email_address ?? '';
  }
  if (!email) email = `${clerkUserId}@users.clerk.local`;

  const first = (profile.first_name ?? '').trim();
  const last = (profile.last_name ?? '').trim();
  const name = `${first} ${last}`.trim() || email.split('@')[0] || clerkUserId;
  return { email, name };
}

/** Placeholder identity when the profile fetch fails — never lock a verified session out. */
export function placeholderIdentity(clerkUserId: string): { email: string; name: string } {
  return { email: `${clerkUserId}@users.clerk.local`, name: clerkUserId };
}
