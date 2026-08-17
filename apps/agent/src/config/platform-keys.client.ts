import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';

import type { EnvConfig } from './env.config';

/** Who the key is being resolved for: their session bearer, and the org they are acting in. */
export interface CallerContext {
  token: string | null;
  orgId?: string | null;
}

/** Matches workflow-service's internal issuer; its own, so this token is never a user session. */
const INTERNAL_ISSUER = 'orchestr:internal';
/** Carried BESIDE the caller's own Authorization — the process credential, not the user's. */
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token';
const TOKEN_TTL_SECONDS = 60;
/** The composer status probe runs on page load — a slow service must not hang it. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The Anthropic key lives in workflow-service's store, set from Settings, and belongs to a user
 * or to an organization. This is the only way this process obtains it: asked per turn (and per
 * status probe) FOR A CALLER, never snapshotted, so a key entered in the UI works without
 * restarting the agent container.
 *
 * Two credentials go out. The CALLER's own bearer decides whose key comes back — workflow-service
 * resolves it exactly as it would any request, including the active org. The short-lived HS256
 * token signed with the shared SECRET_KEY proves this is the agent process, so a user token alone
 * can never read a key back out.
 */
@Injectable()
export class PlatformKeysClient {
  private readonly logger = new Logger(PlatformKeysClient.name);
  private readonly base: string;
  private readonly secret: string | null;

  constructor(@Inject(ConfigService) config: ConfigService<{ env: EnvConfig }, true>) {
    const env = config.get('env', { infer: true });
    this.base = env.workflowServiceUrl;
    this.secret = env.serviceSharedSecret;
  }

  /** This caller's Anthropic key, or null when none is set or the service cannot be reached. */
  async anthropicApiKey(caller: CallerContext): Promise<string | null> {
    if (!this.secret || !caller.token) return null;
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/internal/platform-keys/anthropic`, {
        headers: {
          Authorization: `Bearer ${caller.token}`,
          [INTERNAL_TOKEN_HEADER]: await this.token(this.secret),
          ...(caller.orgId ? { 'X-Org-Id': caller.orgId } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      this.logger.warn('workflow-service is unreachable — the composer reports itself unavailable');
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`workflow-service refused the platform-key read (${res.status})`);
      return null;
    }
    const body = (await res.json().catch(() => null)) as { api_key?: unknown } | null;
    return typeof body?.api_key === 'string' && body.api_key ? body.api_key : null;
  }

  private token(secret: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(INTERNAL_ISSUER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS)
      .sign(new TextEncoder().encode(secret));
  }
}
