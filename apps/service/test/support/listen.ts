import type { INestApplication } from '@nestjs/common';

/**
 * Bind ONCE to an exclusive 127.0.0.1 port before any supertest call: otherwise supertest
 * re-`listen(0)`s per request on the IPv6 wildcard, which can route to a foreign process
 * already holding that port on IPv4 (seen as intermittent, unrelated 403s).
 */
export async function listenOnLoopback(app: INestApplication): Promise<void> {
  await app.listen(0, '127.0.0.1');
}
