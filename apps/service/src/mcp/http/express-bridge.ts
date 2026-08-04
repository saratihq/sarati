import { Readable } from 'node:stream';

import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

/** Express holds the socket; the MCP handler speaks Web `Request`/`Response`. This is the only place the two meet. */
export function toWebRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  const host = req.get('host') ?? 'localhost';
  // Body stays out: express already parsed it and the handler takes it as `parsedBody`.
  return new Request(`${req.protocol}://${host}${req.originalUrl}`, {
    method: req.method,
    headers,
  });
}

/** Streams the response through instead of buffering, so SSE frames reach the client as they are produced. */
export async function sendWebResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  // Proxies that buffer would defeat SSE; the header is inert for JSON responses.
  res.setHeader('X-Accel-Buffering', 'no');

  if (!response.body) {
    res.end();
    return;
  }

  const body = Readable.fromWeb(response.body);
  res.on('close', () => body.destroy());
  await new Promise<void>((resolve, reject) => {
    body.pipe(res);
    body.on('end', resolve);
    body.on('error', reject);
  });
}
