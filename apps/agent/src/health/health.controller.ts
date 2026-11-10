import { Controller, Get } from '@nestjs/common';

/** The liveness route, which the container's health check calls. */
export const HEALTH_PATH = '/api/health';

/** Liveness only — this process owns no DB, and service reachability shows up per-session. */
@Controller()
export class HealthController {
  @Get(HEALTH_PATH)
  health(): { status: string } {
    return { status: 'ok' };
  }
}
