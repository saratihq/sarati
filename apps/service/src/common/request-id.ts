import { randomBytes } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_REQUEST_ID_LENGTH = 64;

/** pino-http `genReqId`: honor an incoming `X-Request-ID` (trimmed, capped), else generate one. */
export function genRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  const trimmed = raw?.trim().slice(0, MAX_REQUEST_ID_LENGTH) ?? '';
  const id = trimmed !== '' ? trimmed : randomBytes(6).toString('hex');
  res.setHeader('x-request-id', id);
  return id;
}
