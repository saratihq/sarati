import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';
import { Logger } from 'nestjs-pino';

import { genRequestId } from './common/request-id';
import type { EnvConfig } from './config/env.config';

/**
 * Shared app wiring for main.ts and the e2e harness — identical middleware
 * order in tests and production:
 *   request-id → JSON parser → CORS → routes.
 */
export function configureApp(app: INestApplication): EnvConfig {
  app.useLogger(app.get(Logger));

  const env = app.get(ConfigService<{ env: EnvConfig }, true>).get('env', { infer: true });

  const express = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
  };
  if (env.trustProxyHeaders) express.set('trust proxy', true);

  // Request id first — logs and error responses all see the same id.
  app.use((req: Request, res: Response, next: NextFunction) => {
    (req as unknown as { id: string }).id = genRequestId(req, res);
    next();
  });

  // The `verify` hook stashes the RAW bytes so webhook intake (/api/hooks) can HMAC-verify a
  // provider signature over the exact payload — parsing is lossy for that.
  app.use(
    json({
      limit: env.maxRequestBodyBytes,
      verify: (req: Request & { rawBody?: string }, _res: Response, buf: Buffer) => {
        if (buf.length > 0) req.rawBody = buf.toString('utf8');
      },
    }),
  );

  app.enableCors({
    origin: [...env.corsOriginList],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id'],
    // The export download: the browser client reads the filename + notes.
    exposedHeaders: ['Content-Disposition'],
  });

  app.enableShutdownHooks();
  return env;
}
