/** Domain rule violation with a user-facing message; services throw it, the exception filter maps it. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    /** Structured payload merged into the error response alongside `detail` — never put secrets here. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
