import { isNativeError } from 'node:util/types';

import { ActionError, type FetchLike, type FetchLikeResponse } from '@sarati/actions-sdk';
import { fetch } from 'undici';

import { redirectTarget } from './redirect-location';

/** One request to Composio, before {@link composioFetch} attaches the API key. */
export interface ComposioRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set(['content-encoding', 'content-language', 'content-location', 'content-type']);

function refusal(status: number, message: string): ActionError {
  return new ActionError({ code: 'http_error', message, status, retryable: false });
}

async function send(
  apiKey: string,
  url: string,
  request: ComposioRequest,
  fetchImpl: FetchLike,
): Promise<FetchLikeResponse> {
  try {
    return await fetchImpl(url, {
      ...request,
      headers: { ...request.headers, 'x-api-key': apiKey },
      redirect: 'manual',
    });
  } catch (err) {
    // fetch reports every network failure as "fetch failed"; its cause says what broke.
    if (err instanceof TypeError && isNativeError(err.cause)) throw err.cause;
    // With no cause, fetch refused its own arguments, and its message repeats the URL or the header value.
    if (err instanceof TypeError) {
      throw new ActionError({
        code: 'invalid_input',
        message: `the request to ${new URL(url).origin} could not be sent: fetch refused the URL or a header value`,
        retryable: false,
      });
    }
    throw err;
  }
}

function onward(res: FetchLikeResponse, from: string, origin: string, hops: number): URL {
  const next = REDIRECT_STATUSES.has(res.status) ? redirectTarget(res, from) : undefined;
  if (!next) throw refusal(res.status, `Composio answered ${res.status} with no redirect it could follow`);
  if (next.origin !== origin) {
    throw refusal(
      res.status,
      `Composio answered ${res.status}, a redirect to ${next.origin}${next.pathname}; the API key is only sent to ${origin}, so it was not followed`,
    );
  }
  if (hops === MAX_REDIRECTS) {
    throw refusal(res.status, `Composio redirected more than ${MAX_REDIRECTS} times`);
  }
  return next;
}

// fetch's own rewrite of a redirected request: 303, and 301/302 after a POST, become a body-less GET.
function followUp(request: ComposioRequest, status: number): ComposioRequest {
  const method = request.method.toUpperCase();
  const toGet =
    (status === 303 && method !== 'GET' && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST');
  if (!toGet) return request;
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())),
  );
  return { method: 'GET', headers, signal: request.signal };
}

/** The one way the Composio API key is sent: a redirect is followed only while it stays on `url`'s origin, so neither the key nor the body leaves it. */
export async function composioFetch(
  apiKey: string,
  url: string,
  request: ComposioRequest,
  fetchImpl: FetchLike = fetch,
): Promise<FetchLikeResponse> {
  const origin = new URL(url).origin;
  let target = url;
  let hop = request;
  for (let hops = 0; ; hops += 1) {
    const res = await send(apiKey, target, hop, fetchImpl);
    if (res.status < 300 || res.status >= 400) return res;
    const next = onward(res, target, origin, hops);
    await res.text();
    hop = followUp(hop, res.status);
    target = next.href;
  }
}
