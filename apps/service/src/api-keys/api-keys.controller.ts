import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { WorkflowLifecycleService } from '../workflows/workflow-lifecycle.service';
import { ApiKeysService, type IssuedKey } from './api-keys.service';
import { Scope } from '../auth/scope.decorator';

class CreateKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}

/** Programmatic-access keys (ADR 0037). */
@Controller('api/api-keys')
@UseGuards(AuthGuard)
export class ApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly lifecycle: WorkflowLifecycleService,
  ) {}

  @Scope('key:manage')
  @Get()
  async list(@Req() req: Request): Promise<{ api_keys: Array<Record<string, unknown>> }> {
    return { api_keys: await this.apiKeys.list(requirePrincipal(req).user.id) };
  }

  @Scope('key:manage')
  @Post()
  async create(@Req() req: Request, @Body() body: CreateKeyDto): Promise<IssuedKey> {
    const userId = requirePrincipal(req).user.id;
    const org = await this.lifecycle.personalOrgIdOf(userId);
    // The plaintext `key` is returned ONCE here and never again.
    return this.apiKeys.issue(userId, org, body.name, body.scopes ?? null);
  }

  @Scope('key:manage')
  @Delete(':keyId')
  async revoke(@Req() req: Request, @Param('keyId') keyId: string): Promise<{ status: string }> {
    await this.apiKeys.revoke(requirePrincipal(req).user.id, keyId);
    return { status: 'revoked' };
  }
}
