import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from 'jose';

/** One request the provider received, as it arrived. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** What an endpoint answers; a responder decides per request. */
export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type Responder = (req: RecordedRequest) => Reply | Promise<Reply>;

const json = (body: unknown, status = 200): Reply => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** An OpenID provider in this process whose every answer a test sets, recording what it was sent — the refusals a well-behaved provider never gives. */
export class HostileIdp {
  readonly clientId = 'sarati-hostile';
  readonly clientSecret = 'a secret: with spaces & symbols/+=';
  readonly requests: RecordedRequest[] = [];
  issuer = '';
  base = '';
  discovery: Record<string, unknown> = {};
  discoveryReply: Responder | null = null;
  token: Responder = () => json({ error: 'server_error' }, 500);
  userinfo: Responder = () => json({}, 404);
  private server!: Server;
  private privateKey!: KeyLike;
  private publicJwk!: JWK;

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.privateKey = privateKey;
    this.publicJwk = { ...(await exportJWK(publicKey)), kid: 'hostile-key', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    // A trailing slash, which is part of the issuer and must survive verbatim.
    this.issuer = `${this.base}/tenant/`;
    this.reset();
  }

  /** Back to a well-behaved provider: a sound discovery document, and no recorded requests. */
  reset(): void {
    this.requests.length = 0;
    this.discoveryReply = null;
    this.discovery = {
      issuer: this.issuer,
      authorization_endpoint: `${this.base}/tenant/authorize`,
      token_endpoint: `${this.base}/tenant/token`,
      jwks_uri: `${this.base}/tenant/jwks`,
      userinfo_endpoint: `${this.base}/tenant/userinfo`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      authorization_response_iss_parameter_supported: true,
    };
    this.userinfo = () => json({}, 404);
  }

  /** Answer the next code exchanges with an ID token carrying `claims`, signed as `opts` says. */
  answerWith(
    claims: Record<string, unknown>,
    opts: { header?: Record<string, unknown>; key?: KeyLike | Uint8Array } = {},
  ): void {
    this.token = async () =>
      json({
        access_token: 'an-access-token',
        token_type: 'Bearer',
        id_token: await this.sign(claims, opts),
      });
  }

  /** Sign an ID token as this provider would — or, with `opts`, as it should not. */
  async sign(
    claims: Record<string, unknown>,
    opts: { header?: Record<string, unknown>; key?: KeyLike | Uint8Array } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'hostile-key', ...opts.header })
      .sign(opts.key ?? this.privateKey);
  }

  get jwk(): JWK {
    return this.publicJwk;
  }

  /** The requests made to one path, in order. */
  sent(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: new URL(req.url ?? '/', this.base).pathname,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    this.requests.push(recorded);
    const reply = await this.route(recorded);
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  }

  private route(req: RecordedRequest): Reply | Promise<Reply> {
    switch (req.path) {
      case '/tenant/.well-known/openid-configuration':
        return this.discoveryReply ? this.discoveryReply(req) : json(this.discovery);
      case '/tenant/jwks':
        return json({ keys: [this.publicJwk] });
      case '/tenant/token':
        return this.token(req);
      case '/tenant/userinfo':
        return this.userinfo(req);
      default:
        return json({ error: 'not_found' }, 404);
    }
  }
}
