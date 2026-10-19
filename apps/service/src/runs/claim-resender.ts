import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { errorMessage } from '../common/error-message';
import { RESEND_AFTER_SECONDS } from './run-waits';
import { RunsService } from './runs.service';

/** Sends every claimed decision its run has not taken again: all of them at boot, then any left over on a timer of its own. */
@Injectable()
export class ClaimResender implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClaimResender.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly runs: RunsService) {}

  async onApplicationBootstrap(): Promise<void> {
    // No claim can be in flight before this process serves, so every one is owed a send.
    await this.resend('boot', 0);
    this.timer = setInterval(() => void this.retry(), RESEND_AFTER_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One periodic pass: decisions claimed long enough ago that their send should have landed. */
  retry(): Promise<void> {
    return this.resend('retry', RESEND_AFTER_SECONDS);
  }

  private async resend(when: string, olderThanSeconds: number): Promise<void> {
    try {
      const resent = await this.runs.resendClaims(olderThanSeconds);
      if (resent > 0)
        this.logger.warn(`${when}: sent ${resent} decision(s) again that their runs had not taken`);
    } catch (err) {
      this.logger.error(`${when}: resending claimed decisions failed: ${errorMessage(err)}`);
    }
  }
}
