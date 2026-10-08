import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsObject, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { WorkflowAccessService } from './workflow-access.service';
import { WorkflowLifecycleService } from './workflow-lifecycle.service';
import { Scope } from '../auth/scope.decorator';

class DeployDto {
  @IsObject()
  workflow_json!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  workflow_id?: string;
}

/** Create a workflow from an IR document — stored and immediately runnable. */
@Controller('api/deploy')
@UseGuards(AuthGuard)
export class DeployController {
  constructor(
    private readonly lifecycle: WorkflowLifecycleService,
    private readonly access: WorkflowAccessService,
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Scope('workflow:deploy')
  @Post()
  async deploy(@Req() req: Request, @Body() body: DeployDto): Promise<Record<string, unknown>> {
    const principal = requirePrincipal(req);
    await this.access.requireCreate(principal, 'deploy');
    return this.lifecycle.deployCreateOnSarati(principal, body.workflow_json);
  }
}
