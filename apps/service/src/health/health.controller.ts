import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';

import { errorMessage } from '../common/error-message';
import { PG_POOL } from '../database/database.module';

/** Liveness (`/api/health`, no I/O) and readiness (`/api/ready`, where a failed DB check gates 503). */
@Controller('api')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    let databaseOk = false;
    try {
      await this.pool.query('SELECT 1');
      databaseOk = true;
    } catch (err) {
      this.logger.warn(`Readiness DB check failed: ${errorMessage(err)}`);
    }

    res.status(databaseOk ? 200 : 503).json({
      status: databaseOk ? 'ready' : 'degraded',
      database: databaseOk,
    });
  }
}
