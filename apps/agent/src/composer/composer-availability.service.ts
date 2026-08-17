import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ComposerDisabledReason, EnvConfig } from '../config/env.config';
import { PlatformKeysClient, type CallerContext } from '../config/platform-keys.client';

/** One actionable sentence per reason — surfaced verbatim by the client. */
export const DISABLED_MESSAGE = {
  anthropic_api_key_missing:
    "The AI composer needs an Anthropic API key. Add one under Settings → Platform keys — your own, or your organization's if you are working in one; it takes effect immediately.",
  caller_auth_unconfigured:
    'The AI composer is not configured on this instance. Set SECRET_KEY to the same value the workflow service uses — it both authenticates composer callers and is how the composer reads the Anthropic key stored in Settings — and CLERK_ISSUER as well for a Clerk deployment. Then restart to enable it.',
} as const;

/**
 * Why the composer is off, answered per request rather than at boot: the Anthropic key is
 * stored by workflow-service and set from Settings, so "disabled" stops being a startup fact.
 *
 * Caller auth is checked FIRST because it is the only one still fixed by an operator editing
 * env — and without it nobody can sign in to reach Settings and set the key at all.
 */
@Injectable()
export class ComposerAvailability {
  private readonly env: EnvConfig;

  constructor(
    @Inject(ConfigService) config: ConfigService<{ env: EnvConfig }, true>,
    private readonly platformKeys: PlatformKeysClient,
  ) {
    this.env = config.get('env', { infer: true });
  }

  /**
   * Null when the composer can run FOR THIS CALLER — the key is theirs or their org's.
   * `keyless` skips the per-caller half: use it where a caller has not been established yet,
   * so an unauthenticated request gets a 401 from the auth guard rather than a misleading 503.
   */
  async disabledReason(
    caller: CallerContext,
    opts: { keyless?: boolean } = {},
  ): Promise<ComposerDisabledReason | null> {
    // The shared secret is BOTH halves: it verifies local sessions and authenticates the
    // read of the stored key, so without it no amount of Settings work can help.
    if (!this.env.callerAuthConfigured || !this.env.serviceSharedSecret) {
      return 'caller_auth_unconfigured';
    }
    if (opts.keyless) return null;
    if (!(await this.platformKeys.anthropicApiKey(caller))) return 'anthropic_api_key_missing';
    return null;
  }
}
