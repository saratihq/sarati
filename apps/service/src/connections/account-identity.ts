import { isRecord } from '../common/json-util';

/**
 * WHICH account a connection is authorized against. Health is not identity: a credential that works
 * perfectly against the wrong workspace is indistinguishable from one that works against the right
 * one, and only this separates them.
 */
export interface AccountIdentity {
  /** `user` when the answer names who the credential acts as; `workspace` when it names only where it is. */
  subject: 'user' | 'workspace';
  /** Human name of the account or workspace, when the provider names one. */
  name: string | null;
  /** The provider's stable id for it — what actually settles a "wrong workspace" argument. */
  id: string | null;
  email: string | null;
  /** The login or username the provider addresses the account by. */
  handle: string | null;
}

/** What a person recognises the account by: its email, else its handle, name or id. */
export function accountLabel(identity: AccountIdentity): string {
  return identity.email ?? identity.handle ?? identity.name ?? identity.id ?? 'an unnamed account';
}

/** `orchestr (T0BFMNPDEQ2)` — the label plus the id a person can compare against what they see in the provider. */
export function describeAccount(identity: AccountIdentity): string {
  const label = accountLabel(identity);
  return identity.id !== null && identity.id !== label ? `${label} (${identity.id})` : label;
}

/** A stored identity read back, or null when there is none or it is not one this code wrote. */
export function storedAccount(raw: unknown): AccountIdentity | null {
  if (!isRecord(raw) || (raw.subject !== 'user' && raw.subject !== 'workspace')) return null;
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return {
    subject: raw.subject,
    name: text(raw.name),
    id: text(raw.id),
    email: text(raw.email),
    handle: text(raw.handle),
  };
}
