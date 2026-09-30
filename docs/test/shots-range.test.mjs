import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { createTestHarness } from 'wrangler';

const VIDEO = '/shots/agent-review-merge.mp4';
const file = readFileSync(new URL(`../public${VIDEO}`, import.meta.url));
const server = createTestHarness({ workers: [{ configPath: new URL('../wrangler.jsonc', import.meta.url) }] });

before(() => server.listen());
after(() => server.close());

test('a video range comes back as a 206 carrying exactly those bytes', async () => {
  const res = await server.fetch(VIDEO, { headers: { range: 'bytes=100-199' } });

  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${file.length}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), file.subarray(100, 200));
});

test('an open range and a suffix range both run to the end of the file', async () => {
  const open = await server.fetch(VIDEO, { headers: { range: `bytes=${file.length - 5}-` } });
  const suffix = await server.fetch(VIDEO, { headers: { range: 'bytes=-5' } });

  for (const res of [open, suffix]) {
    assert.equal(res.status, 206);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), file.subarray(file.length - 5));
  }
});

test('a range past the end is refused, and a plain request says ranges are served', async () => {
  const past = await server.fetch(VIDEO, { headers: { range: `bytes=${file.length}-` } });
  const whole = await server.fetch(VIDEO);

  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${file.length}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal((await whole.arrayBuffer()).byteLength, file.length);
});

test('pages and screenshots never reach the Worker', async () => {
  const page = await server.fetch('/start/how-it-works/', { headers: { range: 'bytes=0-1' } });
  const shot = await server.fetch('/shots/canvas-dark.webp', { headers: { range: 'bytes=0-1' } });

  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('accept-ranges'), null);
});
