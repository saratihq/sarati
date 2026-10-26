import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { loggedUrl } from '../common/request-log-redaction';
import { AuthGuard } from './auth.guard';
import { SCOPE_METADATA } from './scope.decorator';

const SRC_ROOT = join(__dirname, '..');

/** Controllers deliberately reachable without a principal — each carries its own signature/verification suite. */
const PUBLIC_CONTROLLERS = [
  // Login and registration are how a caller GETS a session, so they cannot require one. Both are
  // rate-limited, and registration is bootstrap-or-invite only.
  'auth/local/local-auth.controller.ts',
  'health/health.controller.ts',
  // An invitee has no account yet on a self-hosted instance, so reading which org they were
  // invited to cannot require one; the token is the capability.
  'orgs/invite-preview.controller.ts',
  'triggers/chat.controller.ts',
  'triggers/hooks.controller.ts',
];

/** Routes whose path parameters are a credential, each marked `@CapabilityPath()` at its handler so the request log replaces them. */
const CAPABILITY_ROUTES = [
  '/api/catch/:catchId',
  '/api/chat/:workflowId/:env',
  '/api/chat/:workflowId/:env/events',
  '/api/hooks/:workflowId/:env',
  '/api/hooks/catch/:catchId',
  '/api/orgs/invites/:token',
  '/api/orgs/invites/:token/accept',
];

const PLACEHOLDER = 'path-credential';

const loggedRoute = (route: string): string => loggedUrl(route.replace(/:\w+/g, PLACEHOLDER));

type Ctor = new (...args: never[]) => object;

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

function exportedControllers(module: Record<string, unknown>): Ctor[] {
  return Object.values(module).filter(
    (value): value is Ctor =>
      typeof value === 'function' && Reflect.getMetadata(PATH_METADATA, value) !== undefined,
  );
}

function routeHandlers(controller: Ctor): { name: string; handler: object }[] {
  return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as unknown;
    if (typeof handler !== 'function') return [];
    return Reflect.getMetadata(METHOD_METADATA, handler) === undefined ? [] : [{ name, handler }];
  });
}

function guardedByAuth(controller: Ctor, handler: object): boolean {
  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
  ];
  return guards.includes(AuthGuard);
}

function routePath(controller: Ctor, handler: object): string {
  const parts = [Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler)];
  return `/${parts
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;
}

function declaredScope(controller: Ctor, handler: object): unknown {
  return Reflect.getMetadata(SCOPE_METADATA, handler) ?? Reflect.getMetadata(SCOPE_METADATA, controller);
}

/** The guard denies unannotated routes at runtime — this catches the omission at build time. */
describe('API-key scope coverage', () => {
  const files = controllerFiles(SRC_ROOT).sort();
  const authenticated: string[] = [];
  const unannotated: string[] = [];
  const publicControllers: string[] = [];
  const routes: string[] = [];
  const publicRoutes: string[] = [];

  beforeAll(() => {
    for (const file of files) {
      const relativePath = relative(SRC_ROOT, file);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const module = require(file) as Record<string, unknown>;
      for (const controller of exportedControllers(module)) {
        const handlers = routeHandlers(controller);
        if (handlers.length === 0) continue;
        for (const { handler } of handlers) {
          routes.push(routePath(controller, handler));
          if (!guardedByAuth(controller, handler)) publicRoutes.push(routePath(controller, handler));
        }
        if (!handlers.some((h) => guardedByAuth(controller, h.handler))) {
          publicControllers.push(relativePath);
          continue;
        }
        for (const { name, handler } of handlers) {
          const route = `${relativePath} → ${controller.name}.${name}`;
          authenticated.push(route);
          if (declaredScope(controller, handler) === undefined) unannotated.push(route);
        }
      }
    }
  });

  it('finds the controllers to check', () => {
    expect(files.length).toBeGreaterThan(15);
    expect(authenticated.length).toBeGreaterThan(80);
  });

  it('every authenticated route declares a required scope', () => {
    expect(unannotated).toEqual([]);
  });

  it('the controllers open to unauthenticated callers are exactly the reviewed set', () => {
    expect([...new Set(publicControllers)].sort()).toEqual(PUBLIC_CONTROLLERS);
  });

  it('no path parameter of a route open to unauthenticated callers reaches the request log', () => {
    const parameterised = publicRoutes.filter((route) => route.includes('/:'));
    expect(parameterised.length).toBeGreaterThan(3);
    expect(parameterised.filter((route) => loggedRoute(route).includes(PLACEHOLDER))).toEqual([]);
  });

  it('the routes whose path parameters the request log replaces are exactly the reviewed set, each in full', () => {
    const replaced = [...new Set(routes.filter((route) => loggedRoute(route).includes('[REDACTED]')))];
    expect(replaced.sort()).toEqual(CAPABILITY_ROUTES);
    expect(CAPABILITY_ROUTES.filter((route) => loggedRoute(route).includes(PLACEHOLDER))).toEqual([]);
  });
});
