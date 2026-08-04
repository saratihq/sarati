import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { genRequestId } from './common/request-id';
import { validateEnv } from './config/env.config';
import { ComposerModule } from './composer/composer.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ env: validateEnv(process.env) })],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req, res) => {
          const existing = (req as unknown as { id?: unknown }).id;
          return typeof existing === 'string' ? existing : genRequestId(req, res);
        },
        autoLogging: true,
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          censor: '[REDACTED]',
        },
        level: process.env.LOG_LEVEL ?? 'info',
      },
    }),
    ComposerModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
