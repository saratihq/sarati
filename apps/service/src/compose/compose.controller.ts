import { Body, Controller, Get, HttpException, Post, Query, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Allow, IsArray, IsObject, IsOptional } from 'class-validator';

import { AuthGuard } from '../auth/auth.guard';
import type { WorkflowIR } from '../ir/models';

import { ApplyOpsError, applyOps, MAX_OPS_PER_BATCH, parseOp } from './apply-ops';
import type { DetailedCatalogEntry } from './catalog-entry';
import {
  ComposeCatalogService,
  type CatalogSearchKind,
  type CatalogSearchPage,
} from './compose-catalog.service';
import { composerMerge, type ComposerMergeResult } from './compose-merge';
import { Scope } from '../auth/scope.decorator';
import { PlatformKeysService, type PlatformKeyScope } from '../platform/platform-keys.service';
import { requirePrincipal } from '../auth/principal';

class MergeDto {
  /** The canvas at turn start. */
  @IsObject()
  base!: Record<string, unknown>;

  /** The user's live canvas (its edits win provisionally on conflicts). */
  @IsObject()
  ours!: Record<string, unknown>;

  /** The agent's draft. */
  @IsObject()
  theirs!: Record<string, unknown>;
}

class ApplyOpsDto {
  /** The draft document to mutate; null/omitted starts a blank workflow. */
  @IsOptional()
  @IsObject()
  ir?: Record<string, unknown> | null;

  /** Batched graph ops — validated per-op in code so errors name the op and field. */
  @IsArray()
  @Allow()
  ops!: unknown[];
}

/**
 * The composer agent's service surface: `apply-ops` mutates a DRAFT IR (never commits a version —
 * the draft lives with the caller), `catalog` is the lean retrieval its search_catalog tool wraps.
 */
@Controller('api/compose')
@UseGuards(AuthGuard)
export class ComposeController {
  constructor(
    private readonly catalog: ComposeCatalogService,
    private readonly platformKeys: PlatformKeysService,
  ) {}

  /** Whose managed catalog this caller sees — their active context. */
  private scope(req: Request): Promise<PlatformKeyScope> {
    const principal = requirePrincipal(req);
    return this.platformKeys.scopeFor(principal.user.id, principal.activeOrgId);
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Scope('workflow:write')
  @Post('apply-ops')
  async applyOps(@Req() req: Request, @Body() body: ApplyOpsDto): Promise<{ ir: WorkflowIR }> {
    if (body.ops.length === 0) {
      throw new HttpException({ detail: 'ops must be a non-empty array' }, 422);
    }
    if (body.ops.length > MAX_OPS_PER_BATCH) {
      throw new HttpException({ detail: `too many ops in one batch (max ${MAX_OPS_PER_BATCH})` }, 422);
    }
    const allowedTriggerTypes = await this.catalog.allowedTriggerTypes(await this.scope(req));
    try {
      const ops = body.ops.map((raw, i) => parseOp(raw, i));
      const ir = applyOps(irOrNull(body.ir), ops, this.catalog.allowedTypes(), allowedTriggerTypes);
      return { ir };
    } catch (err) {
      if (err instanceof ApplyOpsError) {
        // 422 with the agent-facing message — the tool echoes it into the loop.
        throw new HttpException({ detail: err.message }, 422);
      }
      throw err;
    }
  }

  /**
   * Live co-editing reconciliation: a stateless three-way merge over the SAME IR merge core the
   * review flow uses. Always returns a document (ours-wins); real conflicts ride along for the agent.
   */
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Scope('workflow:write')
  @Post('merge')
  merge(@Body() body: MergeDto): ComposerMergeResult {
    return composerMerge(
      requireIr(body.base, 'base'),
      requireIr(body.ours, 'ours'),
      requireIr(body.theirs, 'theirs'),
    );
  }

  @Scope('workflow:read')
  @Get('catalog')
  async search(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('top_k') topK?: string,
    @Query('type') type?: string,
    @Query('kind') kind?: string,
    @Query('cursor') cursor?: string,
  ): Promise<CatalogSearchPage | { entry: DetailedCatalogEntry }> {
    // Exact lookup: ?type= returns ONE action or trigger with its full parameter schema.
    if (type !== undefined && type !== '') {
      const entry = await this.catalog.byType(await this.scope(req), type.trim());
      if (!entry) throw new HttpException({ detail: `Unknown action type '${type.trim()}'` }, 404);
      return { entry };
    }
    const query = (q ?? '').trim();
    if (!query) throw new HttpException({ detail: 'q or type is required' }, 400);
    const parsed = topK !== undefined && topK !== '' ? Number(topK) : 8;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
      throw new HttpException({ detail: 'top_k must be an integer between 1 and 25' }, 400);
    }
    return this.catalog.search({
      scope: await this.scope(req),
      query,
      kind: parseKind(kind),
      limit: parsed,
      ...(cursor ? { cursor } : {}),
    });
  }
}

/** Steps only by default — the composer asks for triggers explicitly, as the picker does. */
function parseKind(kind: string | undefined): CatalogSearchKind {
  if (kind === undefined || kind === '') return 'action';
  if (kind === 'action' || kind === 'trigger' || kind === 'any') return kind;
  throw new HttpException({ detail: "kind must be one of 'action', 'trigger', 'any'" }, 400);
}

function requireIr(doc: Record<string, unknown>, name: string): WorkflowIR {
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
    throw new HttpException(
      { detail: `${name} must be a WorkflowIR document with nodes[] and edges[]` },
      422,
    );
  }
  return doc as unknown as WorkflowIR;
}

/** Absent ir starts a blank draft; a PRESENT but malformed one must never silently become one. */
function irOrNull(ir: Record<string, unknown> | null | undefined): WorkflowIR | null {
  if (ir === undefined || ir === null) return null;
  if (!Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) {
    throw new HttpException({ detail: 'ir must be a WorkflowIR document with nodes[] and edges[]' }, 422);
  }
  return ir as unknown as WorkflowIR;
}
