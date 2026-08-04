import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { genRequestId } from './common/request-id';
import type { EnvConfig } from './config/env.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const env = app.get(ConfigService<{ env: EnvConfig }, true>).get('env', { infer: true });

  // Callers are Clerk-verified (A2); MOCK_AUTH is the dev-only bypass and
  // refuses to boot in production (env validation).
  if (env.mockAuth) {
    logger.warn(
      'MOCK_AUTH is enabled — caller authentication is bypassed and tool calls use the fallback ork_ key. Development only.',
      'Bootstrap',
    );
  }

  // Booting disabled is intended for a keyless self-host, but it is also what a
  // typo'd CLERK_ISSUER looks like on a deploy that meant to have a composer —
  // so say it loudly at boot rather than leaving it to whoever reads the probe.
  if (env.composerDisabledReason !== null) {
    logger.warn(
      `The AI composer is DISABLED (${env.composerDisabledReason}) — /api/composer/* answers 503 and /api/composer/status reports why. Set the missing variable and restart to enable it.`,
      'Bootstrap',
    );
  }

  // Request id first — logs and error responses all see the same id.
  app.use((req: Request, res: Response, next: NextFunction) => {
    (req as unknown as { id: string }).id = genRequestId(req, res);
    next();
  });

  app.enableCors({
    origin: [...env.corsOriginList],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id'],
  });

  app.enableShutdownHooks();
  await app.listen(env.port);
}

void bootstrap();
