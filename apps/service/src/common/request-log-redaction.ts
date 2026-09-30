import { INTERNAL_TOKEN_HEADER } from '../platform/internal-token';

/** Request headers that carry a credential; the request log prints every other header as received. */
export const CREDENTIAL_HEADERS = ['authorization', 'cookie', INTERNAL_TOKEN_HEADER] as const;

/** pino redaction for the request log: a credential header is replaced, never printed. */
export const REQUEST_LOG_REDACTION = {
  paths: CREDENTIAL_HEADERS.map((header) => `req.headers["${header}"]`),
  censor: '[REDACTED]',
};
