import { UnauthorizedException } from '@nestjs/common';

/** Valid token past its exp — surfaces as 401 "Token expired" so clients can silent-refresh. */
export class TokenExpiredError extends Error {
  constructor() {
    super('Token expired');
    this.name = 'TokenExpiredError';
  }
}

/** Any other verification failure — surfaces as 401 "Invalid token". */
export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTokenError';
  }
}

/** The generic 401 a rejected token answers with, so it tells an attacker nothing; null for any other error. */
export function tokenRejection(err: unknown): UnauthorizedException | null {
  if (err instanceof TokenExpiredError) {
    return new UnauthorizedException({ detail: 'Token expired', code: 'token_expired' });
  }
  if (err instanceof InvalidTokenError) {
    return new UnauthorizedException({ detail: 'Invalid token', code: 'token_rejected' });
  }
  return null;
}
