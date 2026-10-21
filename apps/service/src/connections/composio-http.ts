import { ActionError, type FetchLike, type FetchLikeResponse } from '@sarati/actions-sdk';
import { fetch } from 'undici';

import { redirectLocation } from './redirect-location';

/** One request to Composio, before {@link composioFetch} attaches the API key. */
export interface ComposioRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/** The one way the Composio API key is sent: a redirect is refused, never followed, so neither the key nor the body leaves `url`'s origin. */
export async function composioFetch(
  apiKey: string,
  url: string,
  request: ComposioRequest,
  fetchImpl: FetchLike = fetch,
): Promise<FetchLikeResponse> {
  let res: FetchLikeResponse;
  try {
    res = await fetchImpl(url, {
      ...request,
      headers: { ...request.headers, 'x-api-key': apiKey },
      redirect: 'manual',
    });
  } catch (err) {
    // fetch reports every network failure as "fetch failed"; its cause says what broke.
    throw err instanceof TypeError && err.cause instanceof Error ? err.cause : err;
  }
  if (res.status < 300 || res.status >= 400) return res;
  const target = redirectLocation(res, url);
  throw new ActionError({
    code: 'http_error',
    message: `Composio answered ${res.status}, a redirect${target ? ` to ${target}` : ''}; the API key is only sent to ${new URL(url).origin}, so it was not followed`,
    status: res.status,
    retryable: false,
  });
}
