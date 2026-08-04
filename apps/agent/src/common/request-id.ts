import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * X-Request-ID on every request/response — reuse the caller's id when present
 * so a composer session traces across agent-service AND workflow-service logs
 * (same convention as workflow-service). Typed against the raw http shapes so
 * both the express middleware and pino-http's genReqId can call it.
 */
export function genRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming)
      ? incoming
      : randomBytes(6).toString('hex');
  res.setHeader('X-Request-ID', id);
  return id;
}
