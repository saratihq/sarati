import type { AccountIdentity } from "@/api/client";

/**
 * `{{$account.<field>}}` — the account a step runs as. The service fills it once the environment has
 * chosen that account, so in production it is the production account, not the author's.
 */
export const ACCOUNT_REF_FIELDS = ["email", "handle", "id", "name"] as const;

export type AccountRefField = (typeof ACCOUNT_REF_FIELDS)[number];

const FIELD_LABELS: Record<AccountRefField, string> = {
  email: "Email",
  handle: "Username",
  id: "ID",
  name: "Name",
};

export function accountRefToken(field: AccountRefField): string {
  return `{{$account.${field}}}`;
}

/** What a step can say about its own account — a person's fields only, since a workspace is nobody's "me". */
export function accountFields(
  account: AccountIdentity | null | undefined,
): Array<{ field: AccountRefField; label: string; value: string }> {
  if (!account || account.subject !== "user") return [];
  return ACCOUNT_REF_FIELDS.flatMap((field) => {
    const value = account[field];
    return value ? [{ field, label: FIELD_LABELS[field], value }] : [];
  });
}

/** Whether the inside of a `{{…}}` is an account reference. */
export function isAccountRef(ref: string): boolean {
  return /^\$account\b/.test(ref.trim());
}

/** What an account reference reads for this account, or null when it can't be known here. */
export function accountRefValue(ref: string, account: AccountIdentity | null | undefined): string | null {
  const field = ref.trim().replace(/^\$account\s*\.?\s*/, "");
  return accountFields(account).find((f) => f.field === field)?.value ?? null;
}

/** A field people most often fill with their own address: To, Cc, Bcc, a recipient. */
export function isEmailRecipientField(key: string): boolean {
  return /^(to|cc|bcc|recipients?|recipient_?emails?|to_?emails?|email_?to)$/i.test(key);
}
