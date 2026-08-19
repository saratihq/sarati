import { requiredConstraintsFor, type RequiredGroup } from '../connections/composio-required-constraints';
import { deriveSupport, supportFacts, type SupportFacts, type SupportInfo } from '../providers/support-tier';

/**
 * The ONE author-time projection of a catalog row. The palette, the composer and the MCP surface
 * all read this — a second projection would let two surfaces disagree about what an action needs.
 */

/** What a row is: a runnable step, a workflow entry point, or a built-in control construct. */
export type CatalogKind = 'action' | 'trigger' | 'control';

/** Which rail runs the row: our clean-room SDK, the Composio broker, or our own engine. */
export type CatalogRail = 'sdk' | 'composio' | 'control' | 'native';

/** A catalog row as an author (human or agent) sees it in a list. */
export interface CatalogEntry {
  name: string;
  type: string;
  kind: CatalogKind;
  rail: CatalogRail;
  category: string;
  description: string;
  /** Coarse requirement: `connection` means a credential must be bound before the row can run. */
  auth: 'none' | 'connection';
  /** The concrete scheme behind `auth` — an SDK row's own scheme, or `managed` when a broker holds it. */
  auth_scheme: string;
  parameters: Record<string, unknown>;
  support: SupportInfo;
  /** The BYO-authable auth scheme — present on SDK rows only. */
  authScheme?: Record<string, unknown>;
  /** An authored example event — present on SDK trigger rows only. */
  sample?: unknown;
}

/** One row with everything needed to configure it — the detail projection behind `describe`. */
export interface DetailedCatalogEntry extends CatalogEntry {
  /** A skeleton config: every required parameter, seeded with its default or a typed placeholder. */
  example_config: Record<string, unknown>;
  /** Groups the published schema under-declares — at least one member of each must be supplied. */
  one_of_constraints: RequiredGroup[];
  /** Non-fatal author-time caveats: what this row cannot promise before it is run. */
  honesty_warnings: string[];
}

/** Facts are derived from a static catalog, so build them once rather than per projected row. */
let facts: SupportFacts | null = null;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function railOf(row: Record<string, unknown>, kind: CatalogKind): CatalogRail {
  if (kind === 'control') return 'control';
  return row.source === 'composio' ? 'composio' : 'sdk';
}

/** The scheme a caller must satisfy: the SDK row's declared one, else the broker's managed flow. */
function authSchemeOf(row: Record<string, unknown>, auth: string): string {
  const declared = record(row.authScheme).type;
  if (typeof declared === 'string' && declared) return declared;
  return auth === 'connection' ? 'managed' : 'none';
}

/** A value that will actually pass validation: the declared default, a listed option, else a placeholder. */
function exampleValue(name: string, schema: Record<string, unknown>): unknown {
  if (schema.defaultValue !== undefined) return schema.defaultValue;
  const options = Array.isArray(schema.options) ? schema.options : [];
  const first = record(options[0]);
  if (first.value !== undefined) return first.value;
  const type = str(schema.type).toLowerCase();
  if (type.includes('multi_select') || type === 'array') return [];
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean' || type === 'checkbox') return false;
  if (type === 'object' || type === 'json') return {};
  return `<${name}>`;
}

function exampleConfig(parameters: Record<string, unknown>): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(parameters)) {
    const schema = record(raw);
    if (schema.required === true) example[name] = exampleValue(name, schema);
  }
  return example;
}

function honestyWarnings(entry: CatalogEntry, groups: readonly RequiredGroup[]): string[] {
  const warnings: string[] = [];
  if (entry.support.tier !== 'instant') warnings.push(`${entry.support.tier}: ${entry.support.reason}.`);
  for (const group of groups) {
    warnings.push(
      `The published schema marks none of these required, but a call without one fails: ${group.oneOf.join(', ')} (${group.label}).`,
    );
  }
  return warnings;
}

/** Project a raw catalog row to the list shape; `rail` is derived for actions and passed for triggers. */
export function toCatalogEntry(
  row: Record<string, unknown>,
  kind: CatalogKind,
  rail: CatalogRail = railOf(row, kind),
): CatalogEntry {
  facts ??= supportFacts();
  const auth = row.auth === 'connection' ? 'connection' : 'none';
  return {
    name: str(row.name),
    type: str(row.type),
    kind,
    rail,
    category: str(row.category),
    description: str(row.description),
    auth,
    auth_scheme: authSchemeOf(row, auth),
    parameters: record(row.parameters),
    support: deriveSupport(row, facts),
    ...(row.authScheme ? { authScheme: record(row.authScheme) } : {}),
    ...(row.sample !== undefined ? { sample: row.sample } : {}),
  };
}

/** Project a raw catalog row to the detail shape — the list fields plus how to configure it. */
export function toDetailedEntry(
  row: Record<string, unknown>,
  kind: CatalogKind,
  rail?: CatalogRail,
): DetailedCatalogEntry {
  const entry = toCatalogEntry(row, kind, rail);
  const groups = [...requiredConstraintsFor(entry.type)];
  return {
    ...entry,
    example_config: exampleConfig(entry.parameters),
    one_of_constraints: groups,
    honesty_warnings: honestyWarnings(entry, groups),
  };
}
