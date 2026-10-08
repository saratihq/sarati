/**
 * `{{$account.<field>}}` — the account a step RUNS AS. The interpreter leaves `$`-refs alone; the action
 * router fills this one once the environment has decided which connection that is (constitution #17).
 */

/** The reserved root — persisted in saved workflows, so renaming it is a data migration. */
export const ACCOUNT_REF_ROOT = '$account';

/** What a `{{$account.…}}` reference may read — persisted in saved workflows, like the root. */
export const ACCOUNT_REF_FIELDS = ['email', 'handle', 'id', 'name'] as const;

export type AccountRefField = (typeof ACCOUNT_REF_FIELDS)[number];

const ACCOUNT_REF = /\{\{\s*\$account\b\s*(?:\.\s*([^}]*?))?\s*\}\}/g;

export function isAccountRefField(field: string): field is AccountRefField {
  return (ACCOUNT_REF_FIELDS as readonly string[]).includes(field);
}

/** How a reference to `field` reads in a message: `{{$account.email}}`, or `{{$account}}` when it names none. */
export function accountRefText(field: string): string {
  return field ? `{{${ACCOUNT_REF_ROOT}.${field}}}` : `{{${ACCOUNT_REF_ROOT}}}`;
}

/** The field each `{{$account…}}` in `value` reads, in order — `''` for one that names no field. */
export function accountRefFields(value: unknown): string[] {
  const fields: string[] = [];
  visitStrings(value, (text) => {
    for (const match of text.matchAll(ACCOUNT_REF)) fields.push((match[1] ?? '').trim());
  });
  return fields;
}

/** `value` with every `{{$account…}}` replaced by `read(field)`, which throws for a field it cannot fill. */
export function fillAccountRefs(value: unknown, read: (field: string) => string): unknown {
  if (typeof value === 'string') {
    return value.replace(ACCOUNT_REF, (_match, field: string | undefined) => read((field ?? '').trim()));
  }
  if (Array.isArray(value)) return value.map((v) => fillAccountRefs(v, read));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = fillAccountRefs(v, read);
    return out;
  }
  return value;
}

function visitStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) visitStrings(v, visit);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) visitStrings(v, visit);
  }
}
