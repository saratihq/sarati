import type { Options } from 'pino-http';

import { HEALTH_PATH } from './health.controller';

/** A request line's level: debug for a liveness probe answered in full below 400, else pino-http's default, info. */
export const requestLogLevel: NonNullable<Options['customLogLevel']> = (req, res, err) => {
  const probe = req.method === 'GET' && req.url?.split('?', 1)[0] === HEALTH_PATH;
  // pino-http's own test for "request completed", so a line it calls "request aborted" is never hidden.
  const completed = res.writableEnded && !req.readableAborted;
  return probe && completed && !err && res.statusCode < 400 ? 'debug' : 'info';
};
