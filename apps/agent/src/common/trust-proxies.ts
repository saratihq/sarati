import type { INestApplication } from '@nestjs/common';

/** Let `req.ip` name the visitor behind `hops` proxies — a count, never `true`, which would trust what the client wrote. */
export function trustProxies(app: INestApplication, hops: number): void {
  if (hops === 0) return;
  const express = app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void };
  express.set('trust proxy', hops);
}
