import { Body, Controller, Delete, Get, Logger, Param, Put, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { Scope } from '../auth/scope.decorator';
import { DomainError } from '../common/domain-error';
import {
  isPlatformKeyName,
  PlatformKeysService,
  type PlatformKeyName,
  type PlatformKeyScope,
  type PlatformKeyState,
} from './platform-keys.service';

class SetPlatformKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  value!: string;
}

/** What the caller's current context is, so the UI can say whose keys it is showing. */
interface PlatformKeysResponse {
  keys: Record<PlatformKeyName, PlatformKeyState>;
  scope: 'user' | 'org';
  can_manage: boolean;
}

/**
 * The two optional platform credentials for the caller's ACTIVE context: a real organization's
 * keys when acting in one, the caller's own otherwise. Write-only — presence is readable, the
 * key itself never leaves the server. Any member reads presence, so a surface whose capability
 * is off can say so; only writing is restricted.
 */
@Controller('api/platform-keys')
@UseGuards(AuthGuard)
export class PlatformKeysController {
  private readonly logger = new Logger(PlatformKeysController.name);

  constructor(private readonly keys: PlatformKeysService) {}

  @Scope('org:manage')
  @Get()
  async list(@Req() req: Request): Promise<PlatformKeysResponse> {
    const { userId, scope } = await this.context(req);
    return {
      keys: await this.keys.presence(scope),
      scope: scope.kind,
      can_manage: await this.keys.canManage(userId, scope),
    };
  }

  @Scope('org:manage')
  @Put(':name')
  async set(
    @Req() req: Request,
    @Param('name') name: string,
    @Body() body: SetPlatformKeyDto,
  ): Promise<{ secret_present: boolean }> {
    const { scope, key } = await this.requireManagerFor(req, name);
    const value = body.value.trim();
    if (!value) throw new DomainError('The key cannot be blank', 400);
    await this.keys.set(scope, key, value);
    await this.warnOnLiveComposioSubscriptions(scope, key);
    return { secret_present: true };
  }

  @Scope('org:manage')
  @Delete(':name')
  async clear(@Req() req: Request, @Param('name') name: string): Promise<{ secret_present: boolean }> {
    const { scope, key } = await this.requireManagerFor(req, name);
    await this.keys.clear(scope, key);
    await this.warnOnLiveComposioSubscriptions(scope, key);
    return { secret_present: false };
  }

  /**
   * Changing a Composio credential leaves any subscription created with the OLD one live in
   * Composio: we cannot delete it without that key, and we do not try. The reconciler re-registers
   * on its next sweep — this says plainly what was left behind so it can be removed there.
   */
  private async warnOnLiveComposioSubscriptions(
    scope: PlatformKeyScope,
    key: PlatformKeyName,
  ): Promise<void> {
    if (key === 'anthropic_api_key') return;
    for (const live of await this.keys.liveComposioSubscriptions(scope)) {
      this.logger.warn(
        `${key} changed for this workspace, but workflow "${live.workflowName}" still has a live ` +
          `${live.triggerType} subscription in Composio, created with the previous key. It keeps ` +
          `delivering and cannot be deleted without that key — remove it in the Composio dashboard.`,
      );
    }
  }

  private async context(req: Request): Promise<{ userId: string; scope: PlatformKeyScope }> {
    const principal = requirePrincipal(req);
    const userId = principal.user.id;
    return { userId, scope: await this.keys.scopeFor(userId, principal.activeOrgId) };
  }

  private async requireManagerFor(
    req: Request,
    name: string,
  ): Promise<{ scope: PlatformKeyScope; key: PlatformKeyName }> {
    const { userId, scope } = await this.context(req);
    if (!(await this.keys.canManage(userId, scope))) {
      throw new DomainError('Only an owner or admin of this organization can change its keys', 403);
    }
    if (!isPlatformKeyName(name)) throw new DomainError('Unknown platform key', 404);
    return { scope, key: name };
  }
}
