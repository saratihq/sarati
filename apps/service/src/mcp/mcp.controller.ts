import { All, Controller, ForbiddenException, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { localhostAllowedOrigins, originValidationResponse } from '@modelcontextprotocol/server';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { principalOf } from '../auth/principal';
import { Scope } from '../auth/scope.decorator';
import type { EnvConfig } from '../config/env.config';
import { sendWebResponse, toWebRequest } from './http/express-bridge';
import { McpHandlerService } from './mcp-handler.service';

/**
 * Streamable HTTP transport for the Platform MCP surface. Per-tool authority comes from
 * the key's scopes; `workflow:read` is the floor for reaching the endpoint at all.
 */
@Controller('mcp')
@UseGuards(AuthGuard)
export class McpController {
  private readonly allowedOrigins: string[];

  constructor(
    private readonly mcp: McpHandlerService,
    config: ConfigService<{ env: EnvConfig }, true>,
  ) {
    const env = config.get('env', { infer: true });
    this.allowedOrigins = [
      ...localhostAllowedOrigins(),
      ...env.corsOriginList.map((origin) => new URL(origin).hostname),
    ];
  }

  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  // Either scope opens a session; the tool list itself is filtered per token beyond this door.
  @Scope('workflow:read', 'workflow:invoke')
  @All()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const request = toWebRequest(req);

    // DNS-rebinding guard: a browser page on another origin must not drive a local MCP server.
    const rejected = originValidationResponse(request, this.allowedOrigins);
    if (rejected) {
      await sendWebResponse(res, rejected);
      return;
    }

    const principal = principalOf(req);
    if (!principal) throw new ForbiddenException({ detail: 'Authentication required.' });

    await sendWebResponse(res, await this.mcp.serve(request, principal, req.body));
  }
}
