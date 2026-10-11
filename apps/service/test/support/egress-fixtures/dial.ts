import { connect } from 'node:net';

/** TEST-NET-1 (RFC 5737): reserved for documentation, so a guard that failed open would still reach nothing. */
export const OUTSIDE = '192.0.2.1';

/** Dials OUTSIDE and swallows the outcome, the way product code logs a failed call and moves on. */
export function dialOutside(): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect({ host: OUTSIDE, port: 9 });
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on('error', () => undefined).on('close', () => resolve());
  });
}
