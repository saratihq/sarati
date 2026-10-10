import { AsyncLocalStorage } from 'node:async_hooks';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

import { ADMIN_URL } from './test-db';

/** One suite's egress: what it reached for that no report has carried yet. */
export interface SuiteEgress {
  testPath: string;
  unreported: string[];
  finished: boolean;
}

/** The guard's process-wide state — every suite in the worker shares it through the `net` module. */
export interface EgressLedger {
  /** The suite whose async context made the call, so a leaked timer is charged to the suite that leaked it. */
  suites: AsyncLocalStorage<SuiteEgress>;
  /** Refusals no suite can report any more: made after their suite finished, or outside every suite. */
  strays: string[];
}

type Fn = (...args: unknown[]) => unknown;
type Check = (self: unknown, args: unknown[]) => string | null;
type Refuse = (target: string) => Error;

const LEDGER = Symbol.for('sarati.e2e.no-egress');
const databaseHost = new URL(ADMIN_URL).hostname.toLowerCase();

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
const unspecified = new net.BlockList();
unspecified.addAddress('0.0.0.0', 'ipv4');
unspecified.addAddress('::', 'ipv6');

/** The guard's state, installing the guard on first use — once per process, whichever realm asks first. */
export function egressLedger(): EgressLedger {
  const holder = net as unknown as Record<symbol, EgressLedger | undefined>;
  return (holder[LEDGER] ??= install());
}

/** The error that reports a suite's unreported refusals, or null when it made none. */
export function refusalReport(suite: SuiteEgress): Error | null {
  const targets = [...new Set(suite.unreported.splice(0))];
  if (targets.length === 0) return null;
  return new Error(
    `e2e egress refused: reached for ${targets.join(', ')} — e2e suites must stay on loopback`,
  );
}

/** Drains the running suite's refusals, so a test that provokes one on purpose can assert on it. */
export function takeRefusals(): string[] {
  return egressLedger().suites.getStore()?.unreported.splice(0) ?? [];
}

function bare(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '');
}

function within(list: net.BlockList, host: string): boolean {
  const address = bare(host);
  const family = net.isIP(address);
  return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function serverAddress(server: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(server);
  if (bracketed) return bracketed[1]!;
  return net.isIP(server) ? server : server.replace(/:\d+$/, '');
}

function isLocalName(host: string): boolean {
  const name = bare(host);
  return name === 'localhost' || name === databaseHost;
}

function install(): EgressLedger {
  const ledger: EgressLedger = { suites: new AsyncLocalStorage(), strays: [] };
  const refuse: Refuse = (target) => {
    const suite = ledger.suites.getStore();
    if (suite && !suite.finished) suite.unreported.push(target);
    else ledger.strays.push(`${target} ${suite ? `after ${suite.testPath} finished` : 'outside any suite'}`);
    return Object.assign(
      new Error(`e2e egress refused: ${target} is not loopback — serve a 127.0.0.1 fixture or inject a fake`),
      { code: 'E2E_EGRESS_REFUSED' },
    );
  };
  guardSockets(refuse);
  guardDatagrams(refuse);
  guardDns(refuse);
  return ledger;
}

function guard(owner: object, name: string, check: Check, promised: boolean, refuse: Refuse): void {
  const methods = owner as Record<string, unknown>;
  const original = methods[name] as Fn;
  const guarded = function (this: unknown, ...args: unknown[]): unknown {
    const target = check(this, args);
    if (target === null) return original.apply(this, args);
    const err = refuse(target);
    if (promised) return Promise.reject(err);
    const callback = args.at(-1);
    if (typeof callback === 'function') process.nextTick(callback, err);
    return undefined;
  };
  // `util.promisify(dns.lookup)` takes its result shape from symbol properties on the original.
  for (const key of Object.getOwnPropertySymbols(original)) {
    Object.defineProperty(guarded, key, Object.getOwnPropertyDescriptor(original, key)!);
  }
  methods[name] = guarded;
}

// A caller's own lookup may answer a local name with an outside address, so the answer is what gets checked.
function answeredWithin(lookup: Fn, accept: (address: string) => boolean, refuse: Refuse): Fn {
  return (hostname: unknown, ...rest: unknown[]) => {
    const callback = rest.pop() as Fn;
    return lookup(hostname, ...rest, (err: unknown, address: unknown, family: unknown) => {
      if (err) return callback(err);
      const answers = Array.isArray(address)
        ? (address as Array<{ address: string }>).map((a) => a.address)
        : [String(address)];
      const outside = answers.find((a) => !accept(a));
      if (outside === undefined) return callback(null, address, family);
      return callback(refuse(`${String(hostname)} → ${outside}`));
    });
  };
}

function guardSockets(refuse: Refuse): void {
  const connect = net.Socket.prototype.connect as unknown as (
    this: net.Socket,
    ...args: unknown[]
  ) => net.Socket;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const [options, callback] = connectArgs(args);
    if (typeof options.path === 'string' && options.path !== '') return connect.apply(this, args);
    const host = typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost';
    if (within(loopback, host)) return connect.apply(this, args);
    if (bare(host) === 'localhost') {
      const lookup =
        typeof options.lookup === 'function' ? (options.lookup as Fn) : (dns.lookup as unknown as Fn);
      const verified = answeredWithin(lookup, (address) => within(loopback, address), refuse);
      return connect.call(this, { ...options, lookup: verified }, callback);
    }
    if (bare(host) === databaseHost) return connect.apply(this, args);
    const err = refuse(`${host}:${String(options.port)}`);
    process.nextTick(() => this.destroy(err));
    return this;
  };
}

function guardDatagrams(refuse: Refuse): void {
  const createSocket = dgram.createSocket as unknown as Fn;
  const local = (address: string): boolean => within(loopback, address) || within(unspecified, address);
  (dgram as { createSocket: unknown }).createSocket = function guardedCreateSocket(
    this: unknown,
    type: unknown,
    ...rest: unknown[]
  ) {
    const options = type as { lookup?: unknown } | string;
    if (typeof options !== 'object' || typeof options.lookup !== 'function') {
      return createSocket.call(this, type, ...rest);
    }
    const lookup = answeredWithin(options.lookup as Fn, local, refuse);
    return createSocket.call(this, { ...options, lookup }, ...rest);
  };
}

function guardDns(refuse: Refuse): void {
  // A bind resolves its address too, so the unspecified addresses pass here but never at connect.
  const lookupCheck: Check = (_, [host]) =>
    typeof host !== 'string' ||
    host === '' ||
    isLocalName(host) ||
    within(loopback, host) ||
    within(unspecified, host)
      ? null
      : `${host} (DNS lookup)`;
  guard(dns, 'lookup', lookupCheck, false, refuse);
  guard(dns.promises, 'lookup', lookupCheck, true, refuse);

  const serviceCheck: Check = (_, [address]) =>
    typeof address === 'string' && within(loopback, address)
      ? null
      : `${String(address)} (DNS lookupService)`;
  guard(dns, 'lookupService', serviceCheck, false, refuse);
  guard(dns.promises, 'lookupService', serviceCheck, true, refuse);

  // A query goes to its servers, and the system's own (even a 127.0.0.53 stub) forwards upstream: only a loopback server a test set up is local.
  const systemServers = new Set(dns.getServers());
  const queryCheck =
    (method: string, servers: (self: unknown) => string[]): Check =>
    (self, [name]) =>
      servers(self).every((s) => !systemServers.has(s) && within(loopback, serverAddress(s)))
        ? null
        : `${String(name)} (DNS ${method} via ${servers(self).join(', ')})`;
  const resolverServers = (resolver: unknown): string[] => (resolver as dns.Resolver).getServers();
  for (const method of Object.getOwnPropertyNames(dns.Resolver.prototype)) {
    if (!method.startsWith('resolve') && method !== 'reverse') continue;
    guard(dns, method, queryCheck(method, dns.getServers), false, refuse);
    guard(dns.promises, method, queryCheck(method, dns.promises.getServers), true, refuse);
    guard(dns.Resolver.prototype, method, queryCheck(method, resolverServers), false, refuse);
    guard(dns.promises.Resolver.prototype, method, queryCheck(method, resolverServers), true, refuse);
  }
}

// `net.connect` hands `Socket#connect` its normalized `[options, cb]` pair; the other forms are Node's own overloads.
function connectArgs(args: unknown[]): [Record<string, unknown>, unknown] {
  const [first, second, third] = args;
  if (Array.isArray(first)) return [first[0] as Record<string, unknown>, first[1]];
  if (typeof first === 'object' && first !== null) return [first as Record<string, unknown>, second];
  if (typeof first === 'string' && Number.isNaN(Number(first))) return [{ path: first }, second];
  return typeof second === 'string' ? [{ port: first, host: second }, third] : [{ port: first }, second];
}
