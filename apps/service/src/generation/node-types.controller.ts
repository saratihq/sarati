import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';
import type { DropdownResult } from '@sarati/actions-sdk';

import { AuthGuard } from '../auth/auth.guard';
import { principalOf } from '../auth/principal';
import { DomainError } from '../common/domain-error';
import {
  toCatalogEntry,
  toDetailedEntry,
  type CatalogEntry,
  type DetailedCatalogEntry,
} from '../compose/catalog-entry';
import { SdkActionsProvider } from '../providers/sdk-actions.provider';
import { SdkPollingProvider } from '../providers/sdk-polling.provider';
import { SdkWebhookProvider } from '../providers/sdk-webhook.provider';

import { CONTROL_NODE_SCHEMAS } from './control-node-types';
import { ENGINE_COLLECTIONS, VectorStore } from './vector-store';
import { Scope } from '../auth/scope.decorator';

/** Request for an SDK action's live option picker (the inspector dropdown). */
class NodeTypeOptionsDto {
  /** The dropdown/multiSelect prop to load options for. */
  @IsString()
  prop!: string;

  /** The connection whose auth the loader fetches with (managed or BYO). */
  @IsOptional()
  @IsString()
  connection_id?: string;

  /** Optional client-side search term to scope the fetch. */
  @IsOptional()
  @IsString()
  search?: string;
}

/**
 * The editor's node-type catalog and live option picker. There is ONE catalog: the
 * hand-coded control nodes plus the action catalog. Triggers aren't placeable steps and live on
 * their own catalog (`GET /api/triggers/catalog`), so no row here is a trigger.
 */
@Controller('api')
@UseGuards(AuthGuard)
export class NodeTypesController {
  constructor(
    private readonly vectorStore: VectorStore,
    private readonly orchestrActions: SdkActionsProvider,
    private readonly sdkPolling: SdkPollingProvider,
    private readonly sdkWebhooks: SdkWebhookProvider,
  ) {}

  @Scope('workflow:read')
  @Get('node-types')
  list(): { node_types: CatalogEntry[] } {
    return {
      node_types: this.entriesFor().map(({ row, kind }) => toCatalogEntry(row, kind)),
    };
  }

  @Scope('workflow:read')
  @Get('node-types/:nodeType')
  detail(@Param('nodeType') nodeType: string): DetailedCatalogEntry {
    const entry = this.entriesFor().find(({ row }) => row.type === nodeType);
    if (!entry) throw new DomainError(`Unknown node type '${nodeType}'`, 404);
    return toDetailedEntry(entry.row, entry.kind);
  }

  /**
   * Live dropdown options for an SDK action or trigger; any other type 404s. A loader that can't
   * run degrades to a disabled result so the inspector falls back to a text field.
   */
  @Scope('workflow:read')
  @Post('node-types/:nodeType/options')
  loadOptions(
    @Req() req: Request,
    @Param('nodeType') nodeType: string,
    @Body() body: NodeTypeOptionsDto,
  ): Promise<DropdownResult<unknown>> {
    const principal = principalOf(req);
    if (!principal) throw new DomainError('Unauthenticated', 401);
    const opts = {
      externalUserId: principal.user.id,
      ...(body.connection_id ? { connectionId: body.connection_id } : {}),
      ...(body.search ? { search: body.search } : {}),
    };
    if (this.orchestrActions.has(nodeType)) {
      return this.orchestrActions.loadOptions(nodeType, body.prop, opts);
    }
    if (this.sdkPolling.isPollingTrigger(nodeType)) {
      return this.sdkPolling.loadOptions(nodeType, body.prop, opts);
    }
    if (this.sdkWebhooks.isRegisteredWebhook(nodeType)) {
      return this.sdkWebhooks.loadOptions(nodeType, body.prop, opts);
    }
    throw new DomainError(`No live options for '${nodeType}' — not one of our actions or triggers`, 404);
  }

  /** The placeable rows: control constructs plus the action catalog (which holds no trigger rows). */
  private entriesFor(): Array<{ row: Record<string, unknown>; kind: 'action' | 'control' }> {
    return [
      ...CONTROL_NODE_SCHEMAS.map((row) => ({ row: { ...row }, kind: 'control' as const })),
      ...this.vectorStore
        .entries(ENGINE_COLLECTIONS.orchestr)
        .map((row) => ({ row, kind: 'action' as const })),
    ];
  }
}
