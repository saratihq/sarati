/** One account {@link UNCONNECTED_ACCOUNTS_SQL} finds. */
export interface UnconnectedAccount {
  id: string;
  email: string;
  clerk_user_id: string | null;
  elsewhere: Array<{ issuer: string; subject: string }>;
}

/** The accounts not connected to the issuer in $1 that signed in some other way: a stored `clerk_user_id` (the retired token sign-in, or Clerk), or an identity at another issuer. */
export const UNCONNECTED_ACCOUNTS_SQL = `
  SELECT u.id, u.email, u.clerk_user_id,
         coalesce(json_agg(json_build_object('issuer', o.issuer, 'subject', o.subject) ORDER BY o.issuer)
                  FILTER (WHERE o.id IS NOT NULL), '[]') AS elsewhere
    FROM users u
    LEFT JOIN user_identities o ON o.user_id = u.id
   WHERE NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.issuer = $1)
     AND (u.clerk_user_id IS NOT NULL OR o.id IS NOT NULL)
   GROUP BY u.id
   ORDER BY u.created_at NULLS FIRST, u.id`;

/** Whether a stored `clerk_user_id` was issued by Clerk rather than stored by the retired token sign-in as a provider's subject. */
export function isClerkUserId(id: string): boolean {
  return /^user_[A-Za-z0-9]{20,}$/.test(id);
}
