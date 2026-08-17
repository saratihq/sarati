import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { EncryptionService } from '../common/crypto/encryption.service';
import type { EnvConfig } from '../config/env.config';
import { PlatformKeysService } from './platform-keys.service';

const encryption = (fernetKey: string | null): EncryptionService =>
  new EncryptionService({ get: () => ({ fernetKey }) } as unknown as ConfigService<{ env: EnvConfig }, true>);

const service = (fernetKey: string | null): { svc: PlatformKeysService; writes: unknown[][] } => {
  const writes: unknown[][] = [];
  const ds = {
    query: (sql: string, params: unknown[]) => {
      writes.push([sql, params]);
      return Promise.resolve([]);
    },
  } as unknown as DataSource;
  return { svc: new PlatformKeysService(ds, encryption(fernetKey)), writes };
};

describe('storing a platform key without encryption available', () => {
  const scope = { kind: 'user', userId: '00000000-0000-4000-8000-000000000001' } as const;

  it('refuses rather than writing the key in the clear', async () => {
    const { svc, writes } = service(null);
    await expect(svc.set(scope, 'anthropic_api_key', 'sk-ant-real')).rejects.toThrow(/FERNET_KEY/);
    expect(writes).toHaveLength(0);
  });

  it('stores it once a key is configured', async () => {
    const { svc, writes } = service(randomBytes(32).toString('base64url'));
    await svc.set(scope, 'anthropic_api_key', 'sk-ant-real');
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0])).not.toContain('sk-ant-real');
  });
});
