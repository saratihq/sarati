import { HttpClient } from '@sarati/actions-sdk';
import type { HttpClientOptions, HttpMethod, HttpResponse, RequestOptions } from '@sarati/actions-sdk';

/** State-changing methods that must carry an idempotency key (GET/HEAD are safe). */
const MUTATING = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Stamps a deterministic `Idempotency-Key` (`<baseKey>#<n>`, n per mutating call) so a crash-replay or retry
 * re-issues identical keys and a cooperative API dedupes. Best-effort by nature; an action's own key is left untouched.
 */
export class IdempotencyHttpClient extends HttpClient {
  private seq = 0;

  constructor(
    private readonly baseKey: string,
    options?: HttpClientOptions,
  ) {
    super(options);
  }

  override request<T = unknown>(
    method: HttpMethod,
    url: string,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    if (MUTATING.has(method) && !hasHeader(options.headers, 'idempotency-key')) {
      const headers = {
        ...(options.headers ?? {}),
        'Idempotency-Key': `${this.baseKey}#${(this.seq += 1)}`,
      };
      return super.request<T>(method, url, { ...options, headers });
    }
    return super.request<T>(method, url, options);
  }
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return headers ? Object.keys(headers).some((k) => k.toLowerCase() === name) : false;
}
