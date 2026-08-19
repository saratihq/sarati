/**
 * WHICH account a connection is authorized against. Health is not identity: a credential that works
 * perfectly against the wrong workspace is indistinguishable from one that works against the right
 * one, and only this separates them.
 */
export interface AccountIdentity {
  /** Human name of the account or workspace, when the provider names one. */
  name: string | null;
  /** The provider's stable id for it — what actually settles a "wrong workspace" argument. */
  id: string | null;
}

/** `orchestr (T0BFMNPDEQ2)` — the pair a person can compare against what they see in the provider. */
export function describeAccount(identity: AccountIdentity): string {
  if (identity.name !== null && identity.id !== null) return `${identity.name} (${identity.id})`;
  return identity.name ?? identity.id ?? 'an unnamed account';
}
