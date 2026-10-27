import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';
import { Logger } from 'nestjs-pino';

import { genRequestId } from './common/request-id';
import type { EnvConfig } from './config/env.config';
import { INBOUND_PATHS, inboundBody } from './triggers/inbound-body';

/**
 * Shared app wiring for main.ts and the e2e harness — identical middleware
 * order in tests and production:
 *   request-id → public-intake body reader → JSON parser → CORS → routes.
 */
export function configureApp(app: INestApplication): EnvConfig {
  app.useLogger(app.get(Logger));

  const env = app.get(ConfigService<{ env: EnvConfig }, true>).get('env', { infer: true });

  const express = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
  };
  // A hop count, never `true`: Express would then take the left-most X-Forwarded-For entry, which the client writes.
  if (env.trustProxyHops > 0) express.set('trust proxy', env.trustProxyHops);

  // Request id first — logs and error responses all see the same id.
  app.use((req: Request, res: Response, next: NextFunction) => {
    (req as unknown as { id: string }).id = genRequestId(req, res);
    next();
  });

  // Must precede json(), which then skips the request because its body is already read.
  app.use(INBOUND_PATHS, ...inboundBody(env.maxRequestBodyBytes));
  app.use(json({ limit: env.maxRequestBodyBytes }));

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
