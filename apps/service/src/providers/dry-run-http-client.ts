import { HttpClient } from '@sarati/actions-sdk';
import type { HttpMethod, HttpResponse, RequestOptions } from '@sarati/actions-sdk';

/** State-changing methods a dry run must NOT actually send. */
const MUTATING = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Previews a workflow without real side effects: reads execute for real, mutating requests return a synthetic
 * `{ dry_run: true }` 200. Method is an imperfect proxy for "write", so a read-only POST is stubbed too.
 */
export class DryRunHttpClient extends HttpClient {
  override request<T = unknown>(
    method: HttpMethod,
    url: string,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    if (MUTATING.has(method)) {
      return Promise.resolve({
        status: 200,
        headers: {},
        data: { dry_run: true, skipped: true, method, url } as unknown as T,
      });
    }
    return super.request<T>(method, url, options);
  }
}
