import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ComposerDisabledReason, EnvConfig } from '../config/env.config';
import { DISABLED_MESSAGE } from './composer-enabled.guard';

export interface ComposerStatus {
  status: 'ok' | 'disabled';
  reason?: ComposerDisabledReason;
  message?: string;
  docs?: string;
}

const DOCS_URL =
  'https://github.com/saratihq/sarati/blob/main/apps/agent/README.md#availability--the-self-host-capability-probe';

/**
 * The client's capability probe. Deliberately its own controller: it must NOT
 * carry ComposerAuthGuard (the client reads it before it has a token, and an
 * unconfigured instance has no way to mint one), and that guard is class-level
 * on ComposerController.
 *
 * It lives under /api/composer/ because that is the only prefix the self-host
 * reverse proxy routes here — /api/health would land on workflow-service and
 * answer a confident, wrong "ok".
 *
 * Always 200, even when disabled: a 503 here is indistinguishable from the
 * proxy's own 503 for an upstream that is down, which is precisely the
 * ambiguity this endpoint exists to remove. Unauthenticated, so it reports
 * only whether the feature is configured — never the model or the key.
 */
@Controller('api/composer')
export class ComposerStatusController {
  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  @Get('status')
  status(): ComposerStatus {
    const reason = this.config.get('env', { infer: true }).composerDisabledReason;
    if (reason === null) return { status: 'ok' };
    return { status: 'disabled', reason, message: DISABLED_MESSAGE[reason], docs: DOCS_URL };
  }
}
