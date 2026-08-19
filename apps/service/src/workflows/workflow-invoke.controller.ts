import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { requirePrincipal } from '../auth/principal';
import { Scope } from '../auth/scope.decorator';
import {
  DEFAULT_INVOKE_AWAIT_MS,
  MAX_INVOKE_AWAIT_MS,
  WorkflowInvokeService,
  type InvokeResult,
} from './workflow-invoke.service';

class InvokeDto {
  /** The tool call's arguments — they become the firing event (`{{trigger.<name>}}`). */
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INVOKE_AWAIT_MS)
  await_ms?: number;
}

export { InvokeDto };

/** Workflow-as-tool invocation: the ONE route an agent calls a published workflow through. */
@Controller('api/workflows')
@UseGuards(AuthGuard)
export class WorkflowInvokeController {
  constructor(private readonly invoker: WorkflowInvokeService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Scope('workflow:invoke')
  @HttpCode(200)
  @Post(':workflowId/invoke')
  async invoke(
    @Req() req: Request,
    @Param('workflowId') workflowId: string,
    @Body() body: InvokeDto,
  ): Promise<InvokeResult> {
    return this.invoker.invoke(
      requirePrincipal(req),
      workflowId,
      body.arguments ?? {},
      body.await_ms ?? DEFAULT_INVOKE_AWAIT_MS,
    );
  }
}
