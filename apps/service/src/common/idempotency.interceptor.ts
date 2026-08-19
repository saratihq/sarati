import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { Observable, from, of, switchMap, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import type { DataSource } from 'typeorm';

import { newId, now } from '../database/ids';
import { IdempotencyKeyEntity } from '../database/entities/idempotency-key.entity';
import { principalOf } from '../auth/principal';
import { shapeKnownError } from './all-exceptions.filter';
import { errorMessage } from './error-message';

const PG_UNIQUE_VIOLATION = '23505';

/** Replay window (Stripe-style): after this a key may be GC'd and reused. */
const KEY_TTL_HOURS = 24;

/** Sweeping expired keys is maintenance, not request work — one request in a window pays for it. */
const GC_INTERVAL_MS = 10 * 60 * 1000;
let lastGcAt = 0;

/**
 * The outcome to store, shaped by the SAME function the exception filter uses — a replay must be
 * byte-identical to the original response. An unknown error only the 500 path can shape is stored
 * generically, because its `error_id` belongs to that one attempt.
 */
function outcomeOf(err: unknown): { status: number; body: unknown } {
  const known = shapeKnownError(err);
  return known ?? { status: 500, body: { detail: 'Internal server error' } };
}

/**
 * Honors `Idempotency-Key` on mutating requests: the first completed response is stored
 * per (user, key) and replayed on retry. Requires the principal AuthGuard sets, so it must run after.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next.handle();
    const rawKey = req.headers['idempotency-key'];
    const key = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim();
    if (!key) return next.handle();

    const principal = principalOf(req);
    if (!principal) return next.handle();
    const userId = principal.user.id;

    return from(this.reserve(userId, key, req.method, req.path)).pipe(
      switchMap((existing) => {
        // Same key, different request → refuse rather than replay the wrong endpoint's response.
        if (existing && (existing.method !== req.method || existing.path !== req.path)) {
          throw new HttpException(
            {
              detail:
                `This Idempotency-Key was already used for ${existing.method} ${existing.path} — ` +
                'use a fresh key for each distinct request.',
            },
            422,
          );
        }
        if (existing?.completed) {
          // A stored FAILURE replays as that failure: re-running could fire a side effect the first
          // attempt already fired before it threw.
          if (existing.statusCode && existing.statusCode >= 400) {
            throw new HttpException(
              existing.responseBody ?? {
                detail: 'The original request with this Idempotency-Key failed.',
              },
              existing.statusCode,
            );
          }
          if (existing.statusCode) res.status(existing.statusCode);
          return of(existing.responseBody);
        }
        if (existing && !existing.completed) {
          // A concurrent request with the same key is still in flight.
          throw new HttpException(
            { detail: 'A request with this Idempotency-Key is already in progress' },
            409,
          );
        }
        // Fresh reservation. BOTH outcomes are persisted: releasing the key on error would let a
        // retry re-run a request that already fired a side effect before it threw.
        return next.handle().pipe(
          concatMap(async (body) => {
            await this.settle(userId, key, res.statusCode, body);
            return body as unknown;
          }),
          catchError((err: unknown) => {
            const outcome = outcomeOf(err);
            return from(this.settle(userId, key, outcome.status, outcome.body)).pipe(
              concatMap(() => throwError(() => err)),
            );
          }),
        );
      }),
    );
  }

  /** Record the outcome so a retry replays it instead of executing again. */
  private async settle(userId: string, key: string, statusCode: number, body: unknown): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(IdempotencyKeyEntity)
      .set({
        statusCode,
        completed: true,
        // Bound parameter + cast: `body` may be any JSON value, hence the explicit CAST.
        responseBody: () => 'CAST(:respBody AS json)',
      })
      .where({ userId, idempotencyKey: key })
      .setParameter('respBody', JSON.stringify(body ?? null))
      .execute()
      .catch((err: unknown) => {
        // Fail-open: the response already stands; the key just stays pending and a retry re-executes.
        this.logger.error(
          `Could not record the outcome for Idempotency-Key "${key}" (user ${userId}) — ` +
            `a retry with this key will RE-EXECUTE instead of replaying: ${errorMessage(err)}`,
        );
      });
  }

  /** Drop keys past the replay window so they can be reused; throttled off the hot path. */
  private async collectExpired(em: DataSource['manager']): Promise<void> {
    const elapsed = Date.now() - lastGcAt;
    if (elapsed < GC_INTERVAL_MS) return;
    lastGcAt = Date.now();
    await em
      .query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '${KEY_TTL_HOURS} hours'`)
      .catch((err: unknown) => {
        // Fail-open: maintenance, not request work — expired keys just linger until the next window.
        this.logger.warn(`Idempotency-key GC failed; expired keys were not reclaimed: ${errorMessage(err)}`);
      });
  }

  /** Insert a pending row; on unique clash return the existing one (replay/in-flight). */
  private async reserve(
    userId: string,
    key: string,
    method: string,
    path: string,
  ): Promise<IdempotencyKeyEntity | null> {
    const em = this.dataSource.manager;
    await this.collectExpired(em);
    try {
      await em.insert(IdempotencyKeyEntity, {
        id: newId(),
        userId,
        idempotencyKey: key,
        method,
        path,
        completed: false,
        createdAt: now(),
      });
      return null;
    } catch (err) {
      const code =
        (err as { driverError?: { code?: string }; code?: string }).driverError?.code ??
        (err as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        return em.findOne(IdempotencyKeyEntity, { where: { userId, idempotencyKey: key } });
      }
      throw err;
    }
  }
}
