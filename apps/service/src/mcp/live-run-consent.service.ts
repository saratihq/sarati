import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { DomainError } from '../common/domain-error';

/** How long a dry run's confirmation stays usable — long enough to read the result, short enough to mean something. */
const TTL_MS = 5 * 60 * 1000;

/** How many live runs one credential may fire per hour, so a loop cannot become a broadcast. */
export const LIVE_RUNS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

interface Consent {
  fingerprint: string;
  expiresAt: number;
}

/**
 * Firing for real requires the caller to have just dry-run *this document* and to quote the token that
 * dry run returned (ADR 0052). Single-use and in-memory: a restart — or a second instance — invalidates
 * outstanding consent, which fails closed by asking for another dry run.
 */
@Injectable()
export class LiveRunConsentService {
  private readonly consents = new Map<string, Consent>();
  private readonly liveRuns = new Map<string, number[]>();

  /** A token naming exactly the document that was previewed — quoting it for a different one is refused. */
  issue(userId: string, workflowIr: unknown): string {
    this.expire();
    const token = randomBytes(18).toString('base64url');
    this.consents.set(`${userId}:${token}`, {
      fingerprint: fingerprintOf(workflowIr),
      expiresAt: Date.now() + TTL_MS,
    });
    return token;
  }

  /** Spend the token, or refuse with the reason. */
  consume(userId: string, token: string | undefined, workflowIr: unknown): void {
    this.expire();
    if (!token) {
      throw new DomainError(
        'A live run needs confirmation: dry-run this exact document first and pass the `confirmation_token` it returns.',
        400,
        { code: 'confirmation_required' },
      );
    }
    const key = `${userId}:${token}`;
    const consent = this.consents.get(key);
    if (!consent) {
      throw new DomainError(
        'That confirmation token is unknown or has expired — dry-run the document again to get a fresh one.',
        400,
        { code: 'confirmation_expired' },
      );
    }
    this.consents.delete(key);
    if (consent.fingerprint !== fingerprintOf(workflowIr)) {
      throw new DomainError(
        'That confirmation token was issued for a different document — dry-run the document you are about to run.',
        400,
        { code: 'confirmation_mismatch' },
      );
    }
  }

  /** Count a live run against the credential's hourly budget, or refuse. */
  chargeLiveRun(userId: string): void {
    const now = Date.now();
    const recent = (this.liveRuns.get(userId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= LIVE_RUNS_PER_HOUR) {
      throw new DomainError(
        `This credential has fired ${LIVE_RUNS_PER_HOUR} live runs in the last hour, which is the limit. Dry runs are unaffected.`,
        429,
        { code: 'live_run_budget_exhausted' },
      );
    }
    recent.push(now);
    this.liveRuns.set(userId, recent);
  }

  private expire(): void {
    const now = Date.now();
    for (const [key, consent] of this.consents) {
      if (consent.expiresAt <= now) this.consents.delete(key);
    }
  }
}

/**
 * Consent is bound to the EXACT payload previewed. This is deliberately a byte identity, not
 * `computeDiff`: the vault's content oracle answers "did the meaning change?", and a semantically
 * equal but textually different document must NOT inherit consent to fire real side effects.
 */
function fingerprintOf(workflowIr: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(workflowIr) ?? '', 'utf8')
    .digest('hex');
}
