import type { FetchLikeResponse } from '@sarati/actions-sdk';

/** Where a redirect points, as origin and path only: its query can carry what the server meant for someone else. */
export function redirectLocation(res: FetchLikeResponse, requestUrl: string): string | undefined {
  let location = '';
  res.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'location') location = value;
  });
  if (!location) return undefined;
  try {
    const url = new URL(location, requestUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}
