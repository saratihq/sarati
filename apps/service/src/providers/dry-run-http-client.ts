import { HttpClient } from '@sarati/actions-sdk';
import type { HttpMethod, HttpResponse, RequestOptions } from '@sarati/actions-sdk';

/** State-changing methods a dry run must NOT actually send. */
const MUTATING = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A request a dry run refused to send. */
export interface SkippedRequest {
  method: HttpMethod;
  url: string;
}

/** Thrown at the seam a dry run stops at, so the action aborts instead of reading a fabricated response. */
export class DryRunSkipped extends Error {
  constructor(readonly request: SkippedRequest) {
    super(`${request.method} ${request.url} was not sent (dry run)`);
    this.name = 'DryRunSkipped';
  }
}

/**
 * Previews a workflow without real side effects: reads execute for real, mutating requests are refused at
 * this seam. Method is an imperfect proxy for "write", so a read-only POST is refused too. Refusing rather
 * than stubbing is deliberate — a synthetic body fails the action's own response validation, and the step
 * then reports a provider failure that never happened.
 */
export class DryRunHttpClient extends HttpClient {
  private readonly refused: SkippedRequest[] = [];

  /** The state-changing requests this run would have made, in order. */
  get skipped(): readonly SkippedRequest[] {
    return this.refused;
  }

  override request<T = unknown>(
    method: HttpMethod,
    url: string,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    if (MUTATING.has(method)) {
      const request: SkippedRequest = { method, url };
      this.refused.push(request);
      return Promise.reject(new DryRunSkipped(request));
    }
    return super.request<T>(method, url, options);
  }
}
