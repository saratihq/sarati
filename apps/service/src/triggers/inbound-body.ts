import type { IncomingHttpHeaders } from 'node:http';
import { TextDecoder } from 'node:util';

import type { RawBodyRequest } from '@nestjs/common';
import { raw, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { DomainError } from '../common/domain-error';
import { CHAT_PREFIX, HOOKS_PREFIX } from './canvas/webhook-url';

/** The public intakes, whose senders pick the content type: webhooks, catches, Composio and chat. */
export const INBOUND_PATHS: readonly string[] = [`/${HOOKS_PREFIX}`, `/${CHAT_PREFIX}`];

type BodyKind = 'json' | 'form' | 'text';
type FormFields = Record<string, string | string[]>;

/** Keeps the body's bytes as sent, once any Content-Encoding is undone, as `req.rawBody`, and decodes `req.body` from them. */
export function inboundBody(limit: number): RequestHandler[] {
  return [raw({ type: () => true, limit }), decodeInto];
}

function decodeInto(req: RawBodyRequest<Request>, _res: Response, next: NextFunction): void {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  req.rawBody = bytes;
  try {
    req.body = decodeInboundBody(bytes, req.headers);
  } catch (err) {
    next(err);
    return;
  }
  next();
}

/** A body by media type: any JSON value, form fields (repeats as arrays) or text; `undefined` when empty. */
export function decodeInboundBody(bytes: Buffer, headers: IncomingHttpHeaders): unknown {
  if (bytes.length === 0) return undefined;
  const [mediaType = '', ...params] = (headers['content-type'] ?? '').split(';');
  const type = mediaType.trim().toLowerCase();
  if (type === '') return untypedText(bytes);
  const kind = kindOf(type);
  if (!kind) throw new DomainError(`Unsupported Content-Type "${type}": send JSON, form fields or text`, 415);
  const decoder = decoderFor(charsetOf(params));
  if (kind === 'json') return parseJson(decoder.decode(bytes));
  if (kind === 'text') return decoder.decode(bytes);
  const fields = formFields(bytes, decoder);
  const githubEvent = headers['x-github-event'] === undefined ? undefined : githubPayload(fields);
  return githubEvent === undefined ? fields : parseJson(githubEvent);
}

function kindOf(mediaType: string): BodyKind | null {
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json';
  if (mediaType === 'application/x-www-form-urlencoded') return 'form';
  if (mediaType.startsWith('text/') || mediaType === 'application/xml' || mediaType.endsWith('+xml')) {
    return 'text';
  }
  return null;
}

function untypedText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError('A body with no Content-Type must be UTF-8 text', 415);
  }
}

function charsetOf(params: string[]): string {
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    const charset = param
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (charset) return charset;
  }
  return 'utf-8';
}

function decoderFor(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset);
  } catch {
    throw new DomainError(`Unsupported charset "${charset}"`, 415);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError('The request body is not valid JSON', 400);
  }
}

function formFields(bytes: Buffer, decoder: TextDecoder): FormFields {
  const fields = new Map<string, string | string[]>();
  for (const pair of bytes.toString('latin1').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = formComponent(eq < 0 ? pair : pair.slice(0, eq), decoder);
    const value = eq < 0 ? '' : formComponent(pair.slice(eq + 1), decoder);
    const prior = fields.get(name);
    if (prior === undefined) fields.set(name, value);
    else if (Array.isArray(prior)) prior.push(value);
    else fields.set(name, [prior, value]);
  }
  return Object.fromEntries(fields);
}

// A percent-escape is a byte in the form's charset, so escapes become bytes before any text is decoded.
function formComponent(escaped: string, decoder: TextDecoder): string {
  const latin1 = escaped
    .replaceAll('+', ' ')
    .replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return decoder.decode(Buffer.from(latin1, 'latin1'));
}

// GitHub's form content type sends its JSON event as the one field `payload`.
function githubPayload(fields: FormFields): string | undefined {
  const payload = fields.payload;
  return Object.keys(fields).length === 1 && typeof payload === 'string' ? payload : undefined;
}
