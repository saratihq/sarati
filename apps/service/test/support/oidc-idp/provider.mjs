// A real, OpenID-certified provider on loopback: OIDC_IDP_CONFIG='{"port":9400,"clientId":"sarati","clientSecret":"s","redirectUri":"http://localhost:3100/auth/oidc/callback","accountsFile":"accounts.json"}' node provider.mjs, then OIDC_ISSUER=http://127.0.0.1:9400 with that id and secret; accountsFile maps each sub to its claims, re-read on every sign-in, and any password signs a known sub in.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Provider from 'oidc-provider';

const config = JSON.parse(process.env.OIDC_IDP_CONFIG ?? '{}');
const issuer = `http://127.0.0.1:${config.port}`;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const accounts = () => JSON.parse(readFileSync(config.accountsFile, 'utf8'));

const provider = new Provider(issuer, {
  clients: [
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uris: [config.redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
  ],
  pkce: { required: () => true },
  jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'idp-key', alg: 'RS256', use: 'sig' }] },
  cookies: { keys: ['oidc-idp-test-only-cookie-key'] },
  claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name', 'preferred_username'] },
  features: { devInteractions: { enabled: true } },
  async findAccount(_ctx, sub) {
    const account = accounts()[sub];
    if (!account) return undefined;
    return { accountId: sub, claims: async () => ({ sub, ...account }) };
  },
});

provider.listen(config.port, '127.0.0.1', () => {
  process.stdout.write(`READY ${issuer}\n`);
});
