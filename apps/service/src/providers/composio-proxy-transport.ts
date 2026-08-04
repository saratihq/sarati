import {
  ActionError,
  type FetchLike,
  isFormBody,
  isMultipartBody,
  type JsonValue,
  type NormalizedRequest,
  type NormalizedResponse,
  type RequestBody,
  resolveFetch,
  type Transport,
} from '@sarati/actions-sdk';

import { errorMessage } from '../common/error-message';

/** Headers that must not ride to the proxy — it issues its own request and attaches the real credential itself. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'host',
  'connection',
  'accept-encoding',
  'transfer-encoding',
]);

/** Envelope headers describing the provider↔proxy wire, not our synthetic body. */
const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

const DEFAULT_BASE_URL = 'https://backend.composio.dev';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ComposioProxyTransportOptions {
  /** Composio API key (`x-api-key`). Never logged. */
  apiKey: string;
  /** The managed connected-account id, e.g. `ca__…`. */
  connectedAccountId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

interface ProxyEnvelope {
  data?: unknown;
  status?: number;
  headers?: Record<string, unknown>;
}

/**
 * The managed transport: rewrites an action's request into Composio's raw HTTP proxy, which attaches the real token
 * server-side, so we hold no provider credential. Proxy contract — `endpoint` is a full URL, forwarded headers ride
 * as `parameters`, `body` must be a JSON object, and the envelope's `status` is the PROVIDER's status.
 */
export class ComposioProxyTransport implements Transport {
  readonly kind = 'composio-proxy';
  private readonly apiKey: string;
  private readonly connectedAccountId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ComposioProxyTransportOptions) {
    if (!options.apiKey) {
      throw new ActionError({
        code: 'auth_missing',
        message: 'ComposioProxyTransport requires an apiKey',
        retryable: false,
      });
    }
    if (!options.connectedAccountId) {
      throw new ActionError({
        code: 'auth_missing',
        message: 'ComposioProxyTransport requires a connectedAccountId',
        retryable: false,
      });
    }
    this.apiKey = options.apiKey;
    this.connectedAccountId = options.connectedAccountId;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = resolveFetch(options.fetchImpl);
  }

  async send(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.assertNoBinary(request);
    const payload = this.buildPayload(request);

    // Compose the caller's abort signal (if any) with the timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }

    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/v3/tools/execute/proxy`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      // A failure reaching Composio is a gateway problem — retryable, and carries the real message.
      throw new ActionError({
        code: 'transport_unreachable',
        message: `Composio proxy unreachable: ${errorMessage(err)}`,
        status: 0,
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener('abort', onAbort);
    }

    if (status < 200 || status >= 300) {
      throw new ActionError({
        code: 'transport_unreachable',
        message: `Composio proxy request failed (${status}): ${text.slice(0, 300)}`,
        status,
        retryable: status >= 500 || status === 429,
      });
    }

    let envelope: ProxyEnvelope;
    try {
      envelope = JSON.parse(text) as ProxyEnvelope;
    } catch {
      throw new ActionError({
        code: 'transport_unreachable',
        message: 'Composio proxy returned a non-JSON response',
        status: 502,
        retryable: true,
      });
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(envelope.headers ?? {})) {
      // Response header values are strings; ignore anything else the envelope carries.
      if (typeof value !== 'string') continue;
      if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    return {
      status: typeof envelope.status === 'number' ? envelope.status : 200,
      headers,
      data: envelope.data,
    };
  }

  /** The proxy carries JSON only, so multipart/form/binary is rejected loudly here rather than silently corrupted. */
  private assertNoBinary(request: NormalizedRequest): void {
    if (isMultipartBody(request.body)) {
      throw new ActionError({
        code: 'unsupported_body',
        message:
          'file uploads need a direct (bring-your-own) connection — the managed proxy carries JSON only',
        status: 0,
        retryable: false,
      });
    }
    if (isFormBody(request.body)) {
      throw new ActionError({
        code: 'unsupported_body',
        message:
          'form-encoded bodies need a direct (bring-your-own) connection — the managed proxy carries JSON only',
        status: 0,
        retryable: false,
      });
    }
    if (request.responseType === 'binary') {
      throw new ActionError({
        code: 'unsupported_body',
        message:
          'binary downloads need a direct (bring-your-own) connection — the managed proxy carries JSON only',
        status: 0,
        retryable: false,
      });
    }
  }

  private buildPayload(request: NormalizedRequest): Record<string, JsonValue> {
    const parameters: Array<{ name: string; value: string; type: 'header' }> = [];
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || value === null) continue;
      if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      parameters.push({ name, value: String(value), type: 'header' });
    }

    const payload: Record<string, JsonValue> = {
      connected_account_id: this.connectedAccountId,
      endpoint: request.url,
      method: request.method,
    };
    if (parameters.length > 0) payload.parameters = parameters;
    if (request.body !== undefined) payload.body = this.assertProxyableBody(request.body);
    return payload;
  }

  /** The proxy faithfully carries a JSON *object* only and mangles the rest, so a non-object body is rejected loudly. */
  private assertProxyableBody(body: RequestBody): JsonValue {
    if (
      !isMultipartBody(body) &&
      !isFormBody(body) &&
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body)
    ) {
      return body;
    }
    throw new ActionError({
      code: 'unsupported_body',
      message: 'managed connections carry JSON object request bodies only (got a non-object body)',
      status: 0,
      retryable: false,
    });
  }
}
