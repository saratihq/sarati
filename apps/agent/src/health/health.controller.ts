import { Controller, Get } from '@nestjs/common';

/** Liveness only — this process owns no DB, and service reachability shows up per-session. */
@Controller('api')
export class HealthController {
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
