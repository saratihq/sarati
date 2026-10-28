import { PATH_METADATA } from '@nestjs/common/constants';
import type { StdSerializedResults } from 'pino-http';

import { INTERNAL_TOKEN_HEADER } from '../platform/internal-token';

type SerializedRequest = StdSerializedResults['req'];

const REDACTED = '[REDACTED]';

/** Request headers that carry a credential; the request log prints every other header as received, and a referer as its origin. */
export const CREDENTIAL_HEADERS = ['authorization', 'cookie', INTERNAL_TOKEN_HEADER] as const;

const capabilityHandlers: { controller: object; handler: object }[] = [];
let resolved: { marked: number; templates: string[][] } = { marked: 0, templates: [] };

/** Marks a route whose path parameters are a capability, so holding its URL is holding the access: no log prints them. */
export const CapabilityPath = (): MethodDecorator => (target, _key, descriptor) => {
  capabilityHandlers.push({ controller: target.constructor, handler: descriptor.value as object });
};

const routePaths = (target: object): string[] =>
  [(Reflect.getMetadata(PATH_METADATA, target) as string | string[] | undefined) ?? []].flat();

function capabilityTemplates(): string[][] {
  // Resolved on use, as a method decorator runs before its controller declares its path.
  if (resolved.marked !== capabilityHandlers.length) {
    resolved = {
      marked: capabilityHandlers.length,
      templates: capabilityHandlers.flatMap(({ controller, handler }) =>
        routePaths(controller).flatMap((base) =>
          routePaths(handler).map((path) => `${base}/${path}`.split('/').filter(Boolean)),
        ),
      ),
    };
  }
  return resolved.templates;
}

const isParameter = (part: string | undefined): boolean => part?.startsWith(':') ?? false;

function loggedPath(path: string): string {
  const segments = path.split('/');
  const routed = segments.slice(1, segments.at(-1) === '' ? -1 : undefined).map((s) => s.toLowerCase());
  const matching = capabilityTemplates().filter(
    (template) =>
      template.length === routed.length &&
      template.every((part, i) => isParameter(part) || part.toLowerCase() === routed[i]),
  );
  if (matching.length === 0) return path;
  // A segment that a matching route fixes as a literal is that literal, never a credential.
  const printed = (i: number): boolean =>
    i === 0 || i > routed.length || matching.some((template) => !isParameter(template[i - 1]));
  return segments.map((segment, i) => (printed(i) ? segment : REDACTED)).join('/');
}

function loggedQuery(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals !== -1) return `${pair.slice(0, equals)}=${REDACTED}`;
      return pair === '' ? pair : REDACTED;
    })
    .join('&');
}

/** `url` as a log may print it: every query value and a capability route's parameters replaced, any fragment dropped. */
export function loggedUrl(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//')) return REDACTED;
  const [target = ''] = url.split('#', 1);
  const queryAt = target.indexOf('?');
  if (queryAt === -1) return loggedPath(target);
  return `${loggedPath(target.slice(0, queryAt))}?${loggedQuery(target.slice(queryAt + 1))}`;
}

function loggedHeaders(headers: SerializedRequest['headers']): Record<string, string> {
  const logged = { ...headers };
  for (const header of CREDENTIAL_HEADERS) if (logged[header] !== undefined) logged[header] = REDACTED;
  if (logged.referer !== undefined) logged.referer = URL.parse(logged.referer)?.origin ?? REDACTED;
  return logged;
}

function loggedRequest(req: SerializedRequest): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    url: loggedUrl(req.url),
    headers: loggedHeaders(req.headers),
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

/** pino-http serializers for the request log: a request is printed with no credential, and without the `query`/`params` copies of its URL. */
export const REQUEST_LOG_SERIALIZERS = { req: loggedRequest };
