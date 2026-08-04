import { directOverride } from '../connections/composio-direct-overrides';
import { isExecutableApp } from '../connections/managed-app-rails';

import { appSlugOf, type CatalogEntry, loadComposioCatalog } from './sdk-actions.registry';

/**
 * How ready an app/action is to run, DERIVED from the sources the platform already maintains, never a hand-kept list:
 * `limited` (this action is a known managed-rail gap) → `needs_setup` (a connection with no managed broker) →
 * `instant`. Action-level `limited` only, so the badge stays a rare, precise warning. Pure module, one derivation.
 */

export type SupportTier = 'instant' | 'needs_setup' | 'limited';

/** The `support` field a catalog row carries to the client. */
export interface SupportInfo {
  tier: SupportTier;
  reason: string;
}

/** App-level facts the per-row derivation reads (build once per catalog). */
export interface SupportFacts {
  /** Apps a managed connection can be brokered for (and some rail can run). */
  managed: ReadonlySet<string>;
}

/** A row's public type, narrowed (catalog rows always carry a string type). */
function typeOf(entry: CatalogEntry): string {
  return typeof entry.type === 'string' ? entry.type : '';
}

/** Build the app-level facts the derivation reads (build once per catalog). */
export function supportFacts(): SupportFacts {
  const managed = new Set<string>();
  for (const row of loadComposioCatalog()) {
    const app = appSlugOf(typeOf(row));
    if (app && isExecutableApp(app)) managed.add(app);
  }
  return { managed };
}

/** Derive one catalog row's support tier. See the module doc for the rules. */
export function deriveSupport(entry: CatalogEntry, facts: SupportFacts): SupportInfo {
  const type = typeOf(entry);
  if (directOverride(type) === null) {
    return { tier: 'limited', reason: 'Not available on managed connections yet' };
  }
  if (entry.auth !== 'connection') return { tier: 'instant', reason: 'No account needed' };
  if (!facts.managed.has(appSlugOf(type))) {
    return { tier: 'needs_setup', reason: 'Needs your own OAuth app or API key connected first' };
  }
  return { tier: 'instant', reason: 'One-click managed sign-in available' };
}
