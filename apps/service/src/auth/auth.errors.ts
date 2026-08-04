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
