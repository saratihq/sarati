import type { FetchLikeResponse } from '@sarati/actions-sdk';

/** The URL a redirect points at, resolved against the request's; undefined when it names none that parses. */
export function redirectTarget(res: FetchLikeResponse, requestUrl: string): URL | undefined {
  let location = '';
  res.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'location') location = value;
  });
  if (!location) return undefined;
  try {
    return new URL(location, requestUrl);
  } catch {
    return undefined;
  }
}

/** Where a redirect points, as origin and path only: its query can carry what the server meant for someone else. */
export function redirectLocation(res: FetchLikeResponse, requestUrl: string): string | undefined {
  const url = redirectTarget(res, requestUrl);
  return url ? `${url.origin}${url.pathname}` : undefined;
}
