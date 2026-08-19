import { Injectable, Logger } from '@nestjs/common';

import { DomainError } from '../common/domain-error';
import type { RunActionResult } from '../providers/managed-integration-provider';
import { ComposioProvider } from './composio.provider';
import { directOverride, type DirectToolOverride } from './composio-direct-overrides';
import { upstreamRejection } from './composio-upstream-rejection';
import { requiredConstraintsFor } from './composio-required-constraints';
import { matchTool, translateProps, type PropTranslation, type ToolMatch } from './composio-tool-mapping';
import { toComposioSlug } from './managed-connections.service';
import type { PlatformKeyScope } from '../platform/platform-keys.service';

export interface ComposioExecuteInput {
  /** Whose Composio key runs this — the scope owning the connection/workflow. */
  scope: PlatformKeyScope;
  /** Our app slug, e.g. `trello`, `slack`. */
  appSlug: string;
  /** Our action name (the part after `<app>.`), e.g. `get_card`, `listUsers`. */
  actionName: string;
  /** The node's configured props (upstream refs already resolved). */
  props: Record<string, unknown>;
  /** Composio connected-account id from the managed connection. */
  connectedAccountId: string;
  /** Our end-user id — Composio requires it alongside the account id. */
  userId: string;
  /** The EXACT tool this action was built from (slug + arg names/types/required); absent → the name matcher is used. */
  tool?: {
    slug: string;
    inputProperties: string[];
    inputTypes?: Record<string, string>;
    required?: string[];
  };
}

/**
 * The Composio EXECUTION rail: maps OUR public action to a Composio tool, translates props → arguments, and maps the
 * `{successful,data,error}` envelope back to a `RunActionResult` — runs-but-fails is a step error, never a 500.
 * The managed-connection guard lives in the router; only managed rows reach here.
 */
/** Cache partition per owning scope — one scope's tool matches must not serve another. */
function scopeCacheKey(scope: PlatformKeyScope): string {
  return scope.kind === 'user' ? `u:${scope.userId}` : `o:${scope.orgId}`;
}

@Injectable()
export class ComposioExecutionProvider {
  private readonly logger = new Logger(ComposioExecutionProvider.name);
  /** Resolved tool per `<toolkit>␟<action>`; `null` is a memoised confirmed miss, so we don't re-list on every step. */
  private readonly toolCache = new Map<string, ToolMatch | null>();

  constructor(private readonly composio: ComposioProvider) {}

  /** Whether the fallback rail can run at all for this scope (a Composio key is stored). */
  async isConfigured(scope: PlatformKeyScope): Promise<boolean> {
    return this.composio.isConfigured(scope);
  }

  async execute(input: ComposioExecuteInput): Promise<RunActionResult> {
    const publicType = `${input.appSlug}.${input.actionName}`;
    const noEquivalent = new DomainError(
      `"${publicType}" can't run on a managed connection yet — no equivalent managed action is available`,
    );

    // Curated override first; `null` = a known unmappable action (honest 400).
    const override = directOverride(publicType);
    if (override === null) throw noEquivalent;
    if (override) return this.runOverride(publicType, override, input);

    // The router's exact catalog slug is the common path — no name matching, no misroute.
    const tool = input.tool ?? (await this.matchToolFor(input.scope, input.appSlug, input.actionName));
    if (!tool) throw noEquivalent;

    const base = translateProps(input.props, tool.inputProperties, tool.inputTypes);
    const warnings = this.warningsFromTranslation(publicType, tool.slug, base, base.dropped);
    // Pre-flight so a missing required input is a clean 400 before we burn a Composio call.
    this.assertRequired(publicType, base.arguments, tool.required);

    const data = await this.runTool(input.scope, publicType, tool.slug, {
      connectedAccountId: input.connectedAccountId,
      userId: input.userId,
      arguments: base.arguments,
    });
    return this.withWarnings(data, warnings);
  }

  /**
   * Run a curated override. Its mapping is ADDITIVE (base translation first, overlay on top, overlay wins) only when it
   * targets the SAME tool the catalog recorded — a RETARGETED override would build the base against the wrong tool's
   * args, so there it stays purely replacing.
   */
  private async runOverride(
    publicType: string,
    override: DirectToolOverride,
    input: ComposioExecuteInput,
  ): Promise<RunActionResult> {
    const overlay = override.toArguments(input.props);
    const sameTool = input.tool?.slug === override.toolSlug ? input.tool : undefined;

    let args: Record<string, unknown> = overlay;
    const warnings: string[] = [];
    if (sameTool) {
      const base = translateProps(input.props, sameTool.inputProperties, sameTool.inputTypes);
      args = { ...base.arguments, ...overlay };
      // Only a prop the base couldn't place AND the overlay didn't rescue is a genuine silent drop.
      const genuinelyDropped = base.dropped.filter((name) => !overrideConsumes(override, name, input.props));
      warnings.push(...this.warningsFromTranslation(publicType, override.toolSlug, base, genuinelyDropped));
    }
    // The tool's required flags apply only when the override targets that same tool; the one-of table always applies.
    this.assertRequired(publicType, args, sameTool?.required);

    const data = await this.runTool(input.scope, publicType, override.toolSlug, {
      connectedAccountId: input.connectedAccountId,
      userId: input.userId,
      arguments: args,
    });
    return this.withWarnings(data, warnings);
  }

  /** Non-fatal honesty notes for one translation — `dropped` is a parameter so the override path can pre-filter it. */
  private warningsFromTranslation(
    publicType: string,
    toolSlug: string,
    translation: PropTranslation,
    dropped: string[],
  ): string[] {
    const warnings: string[] = [];
    if (dropped.length > 0) {
      this.logger.warn(
        `Composio ${publicType} → ${toolSlug}: unmapped prop(s) dropped: ${dropped.join(', ')}`,
      );
      for (const name of dropped) {
        warnings.push(`Input "${name}" has no matching argument on ${toolSlug} and was ignored.`);
      }
    }
    for (const name of translation.coercionSkipped) {
      warnings.push(`Input "${name}" couldn't be converted to its declared type; ${toolSlug} may reject it.`);
    }
    return warnings;
  }

  /**
   * Throw a clean 400 for a missing required input BEFORE the Composio call — the tool's declared required args plus
   * the curated one-of groups. `arguments` never holds `undefined`/`null`, so an absent key IS a missing input.
   */
  private assertRequired(
    publicType: string,
    args: Record<string, unknown>,
    toolRequired: string[] | undefined,
  ): void {
    const missing = (toolRequired ?? []).filter((name) => args[name] === undefined || args[name] === null);
    const unmetGroups = requiredConstraintsFor(publicType).filter((group) =>
      group.oneOf.every((name) => args[name] === undefined || args[name] === null),
    );
    if (missing.length === 0 && unmetGroups.length === 0) return;
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required input(s): ${missing.join(', ')}`);
    for (const group of unmetGroups) parts.push(`provide at least one of: ${group.label}`);
    throw new DomainError(`"${publicType}" can't run — ${parts.join('; ')}`, 400);
  }

  /** Attach the honesty channel only when there's something to say (keeps a clean run clean). */
  private withWarnings(data: unknown, warnings: string[]): RunActionResult {
    return warnings.length > 0 ? { output: data, warnings } : { output: data };
  }

  /** Execute a KNOWN tool slug (the caller owns it — no name matching), with the same run-but-fails 422 mapping. */
  executeBySlug(
    scope: PlatformKeyScope,
    toolSlug: string,
    params: { connectedAccountId: string; userId: string; arguments: Record<string, unknown> },
  ): Promise<unknown> {
    return this.runTool(scope, toolSlug, toolSlug, params);
  }

  /** One tools/execute call: ran-but-failed becomes a structured 422 carrying the real message, never an opaque 500. */
  private async runTool(
    scope: PlatformKeyScope,
    label: string,
    toolSlug: string,
    params: { connectedAccountId: string; userId: string; arguments: Record<string, unknown> },
  ): Promise<unknown> {
    const result = await this.composio.executeTool(scope, toolSlug, params);
    if (!result.successful) {
      throw new DomainError(`${label} failed: ${result.error ?? 'the managed action reported failure'}`, 422);
    }
    // `successful` covers the HTTP call, not the API's answer to it.
    const rejected = upstreamRejection(result.data);
    if (rejected) throw new DomainError(`${label} failed: ${rejected}`, 422);
    return result.data;
  }

  /** LAST-RESORT fuzzy matcher for an action NOT in the prebuilt catalog; returns `null` rather than guess. */
  private async matchToolFor(
    scope: PlatformKeyScope,
    appSlug: string,
    actionName: string,
  ): Promise<ToolMatch | null> {
    const toolkit = toComposioSlug(appSlug);
    const key = `${scopeCacheKey(scope)}␟${toolkit}␟${actionName}`;
    const cached = this.toolCache.get(key);
    if (cached !== undefined) return cached;
    const tools = await this.composio.listTools(scope, toolkit);
    const match = matchTool(actionName, toolkit, tools);
    if (!match) {
      this.logger.warn(`Composio fallback: no tool matches ${appSlug}.${actionName} in toolkit "${toolkit}"`);
    }
    this.toolCache.set(key, match);
    return match;
  }
}

/** Whether the override consumes prop `name`, by differential probe: re-run `toArguments` with it present vs removed. */
function overrideConsumes(
  override: DirectToolOverride,
  name: string,
  props: Record<string, unknown>,
): boolean {
  const withProp = override.toArguments(props);
  const without: Record<string, unknown> = { ...props };
  delete without[name];
  const withoutProp = override.toArguments(without);
  return JSON.stringify(withProp) !== JSON.stringify(withoutProp);
}
