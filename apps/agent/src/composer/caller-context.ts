import type { Request } from 'express';

import type { CallerContext } from '../config/platform-keys.client';

/**
 * The caller as workflow-service will see them: their own bearer, and the org they are acting in.
 * The composer never decides whose keys a turn uses — it forwards these and the service resolves.
 */
export function callerOf(req: Request): CallerContext {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  const raw = req.headers['x-org-id'];
  const orgId = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
  return { token: token || null, orgId };
}
