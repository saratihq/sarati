import { randomBytes } from 'node:crypto';

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { DomainError } from './domain-error';

/** The response a KNOWN exception shapes into, or null when only the 500 path can answer (it mints an error id). */
export function shapeKnownError(
  exception: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (exception instanceof ThrottlerException) {
    return { status: 429, body: { detail: 'Rate limit exceeded. Please try again later.' } };
  }
  if (exception instanceof DomainError) {
    // `detail` always wins; a DomainError's structured `details` rides alongside it.
    return { status: exception.status, body: { ...(exception.details ?? {}), detail: exception.message } };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const body = exception.getResponse();
    if (typeof body === 'string') return { status, body: { detail: body } };
    const record = body as Record<string, unknown>;
    // Unmatched routes raise Nest's default 404 — reshape it rather than leak Nest's body.
    if (status === 404 && !('detail' in record)) return { status: 404, body: { detail: 'Not Found' } };
    // ValidationPipe puts an array of strings under `message` — normalize to `detail: [{msg}]`,
    // the shape the frontend's error parser reads.
    const raw = record.detail ?? record.message ?? exception.message;
    const detail = Array.isArray(raw)
      ? (raw as unknown[]).map((m) => (typeof m === 'string' ? { msg: m } : m))
      : raw;
    return { status, body: { ...record, detail } };
  }
  return null;
}

/**
 * The single error-shaping point: every body carries `detail`, and a 500 returns only an `error_id`
 * — the exception text is logged under that id and never echoed to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const known = shapeKnownError(exception);
    if (known) {
      res.status(known.status).json(known.body);
      return;
    }

    // express/raw-body oversize errors (PayloadTooLargeError).
    if (this.isHttpErrorsLike(exception) && exception.status === 413) {
      res.status(413).json({ detail: 'Request body too large' });
      return;
    }

    const errorId = randomBytes(4).toString('hex');
    const err = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      `Unhandled error ${errorId} on ${req.method} ${req.originalUrl}: ${err.message}`,
      err.stack,
    );
    res.status(500).json({ detail: `Internal server error (ref ${errorId})`, error_id: errorId });
  }

  private isHttpErrorsLike(exception: unknown): exception is { status: number } {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'status' in exception &&
      typeof exception.status === 'number'
    );
  }
}
