import { Injectable, Logger } from '@nestjs/common';

import { DomainError } from '../common/domain-error';
import { ComposioProvider } from './composio.provider';
import { ConnectionsService } from './connections.service';
import { isExecutableApp } from './managed-app-rails';
import type { PlatformKeyScope } from '../platform/platform-keys.service';

/** An app offered for one-click managed connect. */
export interface ManagedApp {
  slug: string;
  name: string;
  /** Whether Composio can actually execute the app; `false` still lists it so nothing silently disappears. */
  executable: boolean;
}

/**
 * OUR app slug → Composio toolkit slug, where they differ. Everything user-facing speaks OUR slug;
 * only calls INTO Composio translate.
 */
const COMPOSIO_TOOLKIT_ALIASES: Record<string, string> = {
  bigquery: 'googlebigquery',
  calendar: 'googlecalendar',
  convertkit: 'kit', // ConvertKit rebranded to Kit; Composio tracks the new name
  docs: 'googledocs',
  drive: 'googledrive',
  'facebook-pages': 'facebook',
  'google-chat': 'google_chat',
  onedrive: 'one_drive',
  'outlook-calendar': 'outlook', // one Graph consent backs both outlook apps
  sharepoint: 'share_point',
  sheets: 'googlesheets',
  slides: 'googleslides',
  tasks: 'googletasks',
  teams: 'microsoft_teams',
  'zoho-crm': 'zoho', // Composio's generic Zoho OAuth covers the CRM API
};
export const toComposioSlug = (app: string): string => COMPOSIO_TOOLKIT_ALIASES[app] ?? app;

/**
 * Composio toolkit slug → OUR canonical app slug. Must stay in lockstep with TOOLKIT_TO_SLUG in
 * scripts/build-composio-catalog.mjs, so "offered = has runnable actions" holds.
 */
const TOOLKIT_TO_APP_SLUG: Record<string, string> = {
  googlebigquery: 'bigquery',
  googlecalendar: 'calendar',
  kit: 'convertkit',
  googledocs: 'docs',
  googledrive: 'drive',
  facebook: 'facebook-pages',
  google_chat: 'google-chat',
  one_drive: 'onedrive',
  share_point: 'sharepoint',
  googlesheets: 'sheets',
  googleslides: 'slides',
  googletasks: 'tasks',
  microsoft_teams: 'teams',
  zoho: 'zoho-crm',
};
export const toOurSlug = (toolkit: string): string => TOOLKIT_TO_APP_SLUG[toolkit] ?? toolkit;

/** Our public action-slug rule — a toolkit that can't be addressed as `<slug>.<action>` could never match an action. */
const PUBLIC_SLUG_RE = /^[a-z][a-z0-9_-]*$/;

@Injectable()
export class ManagedConnectionsService {
  private readonly logger = new Logger(ManagedConnectionsService.name);

  constructor(
    private readonly composio: ComposioProvider,
    private readonly connections: ConnectionsService,
  ) {}

  /** Every brokerable app — managed-auth toolkits mapped to OUR slug, deduped, addressable only; `q` filters slug/name. */
  async listApps(scope: PlatformKeyScope, q?: string): Promise<ManagedApp[]> {
    const toolkits = await this.composio.listManagedToolkits(scope);
    const needle = (q ?? '').trim().toLowerCase();
    const bySlug = new Map<string, ManagedApp>();
    for (const t of toolkits) {
      const slug = toOurSlug(t.slug);
      if (!PUBLIC_SLUG_RE.test(slug) || bySlug.has(slug)) continue; // unaddressable or already offered
      bySlug.set(slug, { slug, name: t.name, executable: isExecutableApp(slug) });
    }
    return [...bySlug.values()]
      .filter(
        (a) => !needle || a.slug.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  }

  /** Start a managed connect: ensure the auth config, mint the hosted link, record a PENDING row (no secret). */
  async createLink(
    scope: PlatformKeyScope,
    userId: string,
    app: string,
  ): Promise<{ connectionId: string; redirectUrl: string }> {
    const apps = await this.listApps(scope);
    if (!apps.some((a) => a.slug === app)) {
      throw new DomainError(`App "${app}" is not available for managed connections`);
    }
    const authConfigId = await this.composio.ensureAuthConfig(scope, toComposioSlug(app));
    const { redirectUrl, connectedAccountId } = await this.composio.createLink(scope, userId, authConfigId);
    const connection = await this.connections.createManaged(userId, app, connectedAccountId);
    this.logger.log(`Managed connect started: ${app} → connection ${connection.id} (user ${userId})`);
    return { connectionId: connection.id, redirectUrl };
  }

  /** The ORG CLUSTER variant: same hosted flow, but tagged org+env so env-deployed runs resolve it. */
  async createClusterLink(
    ownerUserId: string,
    orgId: string,
    environment: string,
    app: string,
  ): Promise<{ connectionId: string; redirectUrl: string }> {
    // A cluster connection belongs to the ORG by construction, so its key does too.
    const scope: PlatformKeyScope = { kind: 'org', orgId };
    const apps = await this.listApps(scope);
    if (!apps.some((a) => a.slug === app)) {
      throw new DomainError(`App "${app}" is not available for managed connections`);
    }
    const authConfigId = await this.composio.ensureAuthConfig(scope, toComposioSlug(app));
    const { redirectUrl, connectedAccountId } = await this.composio.createLink(
      scope,
      ownerUserId,
      authConfigId,
    );
    const connection = await this.connections.createManaged(ownerUserId, app, connectedAccountId, {
      orgId,
      environment,
    });
    this.logger.log(
      `Cluster connect started: ${app} → ${environment} cluster of org ${orgId} (connection ${connection.id})`,
    );
    return { connectionId: connection.id, redirectUrl };
  }

  /**
   * The connection's lifecycle status; a pending managed row is polled against Composio and flipped persistently.
   * Three-valued by contract: an EXPIRED during connect persists as `expired` but reports as `failed`.
   */
  async status(
    scope: PlatformKeyScope,
    userId: string,
    id: string,
  ): Promise<'pending' | 'active' | 'failed'> {
    const ref = await this.connections.managedRef(userId, id);
    if (!ref) throw new DomainError('Connection not found', 404);
    if (ref.authType !== 'managed') return 'active';
    if (ref.status !== 'pending') return ref.status === 'active' ? 'active' : 'failed';
    if (!ref.connectedAccountId) {
      // Unreadable reference (corrupt blob / key rotation) — terminal.
      await this.connections.setStatus(
        id,
        'failed',
        'This connection is unreadable — remove it and connect again.',
      );
      return 'failed';
    }
    const status = await this.composio.getAccountStatus(scope, ref.connectedAccountId);
    if (status === 'pending') return 'pending';
    if (status === 'active') {
      await this.connections.setStatus(id, 'active');
      return 'active';
    }
    await this.connections.setStatus(
      id,
      status,
      'The sign-in could not be completed — try connecting again.',
    );
    return 'failed';
  }
}
