interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** A satisfiable single range as inclusive byte offsets; null means serve the whole file. */
export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Parses one `Range: bytes=…` header against a file of `size` bytes, per RFC 9110 §14.1.2. */
export function byteRange(header: string, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    return suffix === 0 ? 'unsatisfiable' : { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return start >= size || start > end ? 'unsatisfiable' : { start, end };
}

/** Static assets answer every Range with the whole file and Chromium cannot seek without a 206, so videos are sliced here. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete('range');
    const asset = await env.ASSETS.fetch(new Request(request, { headers }));

    const out = new Headers(asset.headers);
    out.set('accept-ranges', 'bytes');
    const header = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    if (
      !header ||
      request.method !== 'GET' ||
      asset.status !== 200 ||
      asset.headers.has('content-encoding') ||
      (ifRange !== null && ifRange !== asset.headers.get('etag'))
    ) {
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: out });
    }

    const file = await asset.arrayBuffer();
    const range = byteRange(header, file.byteLength);
    if (range === null) return new Response(file, { status: 200, headers: out });
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.byteLength}` } });
    }
    out.set('content-range', `bytes ${range.start}-${range.end}/${file.byteLength}`);
    out.set('content-length', String(range.end - range.start + 1));
    return new Response(file.slice(range.start, range.end + 1), { status: 206, headers: out });
  },
};
