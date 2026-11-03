import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';

import { EncryptionService } from '../common/crypto/encryption.service';
import type { EnvConfig } from '../config/env.config';
import { PlatformKeysService } from './platform-keys.service';

const encryption = (fernetKey: string | null): EncryptionService =>
  new EncryptionService({ get: () => ({ fernetKey }) } as unknown as ConfigService<{ env: EnvConfig }, true>);

const config = (instance: Partial<EnvConfig> = {}): ConfigService<{ env: EnvConfig }, true> =>
  ({
    get: () => ({ instanceComposioApiKey: '', instanceComposioWebhookSecret: '', ...instance }),
  }) as unknown as ConfigService<{ env: EnvConfig }, true>;

const service = (
  fernetKey: string | null,
  instance: Partial<EnvConfig> = {},
): { svc: PlatformKeysService; writes: unknown[][] } => {
  const writes: unknown[][] = [];
  const em = {
    query: (sql: string, params: unknown[]) => {
      writes.push([sql, params]);
      return Promise.resolve([]);
    },
  } as unknown as EntityManager;
  const ds = {
    transaction: (work: (tx: EntityManager) => Promise<unknown>) => work(em),
  } as unknown as DataSource;
  return { svc: new PlatformKeysService(ds, encryption(fernetKey), config(instance)), writes };
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

describe('an instance that provides its own Composio account', () => {
  const user = { kind: 'user', userId: '00000000-0000-4000-8000-000000000002' } as const;
  const org = { kind: 'org', orgId: '00000000-0000-4000-8000-000000000003' } as const;
  const stored = (rows: Array<{ name: string; secret?: string; updated_at?: Date }>) => {
    const queried: string[] = [];
    const ds = {
      manager: { query: (sql: string) => (queried.push(sql), Promise.resolve(rows)) },
      query: (sql: string) => (queried.push(sql), Promise.resolve(rows)),
    } as unknown as DataSource;
    const fernet = randomBytes(32).toString('base64url');
    return { ds, queried, fernet };
  };
  const instance = { instanceComposioApiKey: 'ak_instance', instanceComposioWebhookSecret: 'whsec_instance' };

  it('answers every scope with its key and secret, reading no stored one, and partitions every scope as one project', async () => {
    const { ds, queried, fernet } = stored([{ name: 'composio_api_key', secret: 'stored' }]);
    const svc = new PlatformKeysService(ds, encryption(fernet), config(instance));
    expect(svc.composioManagedByInstance()).toBe(true);
    await expect(svc.composioApiKey(user)).resolves.toBe('ak_instance');
    await expect(svc.composioApiKey(org)).resolves.toBe('ak_instance');
    await expect(svc.composioWebhookSecret(org)).resolves.toBe('whsec_instance');
    expect(svc.composioPartition(user)).toBe('instance');
    expect(svc.composioPartition(org)).toBe('instance');
    expect(queried).toEqual([]);
  });

  it('refuses to set or remove a Composio key with 409 and writes nothing, while the Anthropic key stays per scope', async () => {
    const { svc, writes } = service(randomBytes(32).toString('base64url'), instance);
    for (const name of ['composio_api_key', 'composio_webhook_secret'] as const) {
      await expect(svc.set(user, name, 'mine')).rejects.toMatchObject({ status: 409 });
      await expect(svc.clear(org, name)).rejects.toMatchObject({ status: 409 });
    }
    expect(writes).toHaveLength(0);
    await svc.set(user, 'anthropic_api_key', 'sk-ant-mine');
    expect(writes).toHaveLength(1);
  });

  it('reports the Composio keys as provided by the instance, never as stored, and the Anthropic key as stored', async () => {
    const at = new Date('2026-11-01T10:00:00Z');
    const { ds, fernet } = stored([
      { name: 'composio_api_key', updated_at: at },
      { name: 'anthropic_api_key', updated_at: at },
    ]);
    const svc = new PlatformKeysService(ds, encryption(fernet), config(instance));
    await expect(svc.presence(user)).resolves.toEqual({
      composio_api_key: { present: true, updated_at: null, managed_by_instance: true },
      composio_webhook_secret: { present: true, updated_at: null, managed_by_instance: true },
      anthropic_api_key: { present: true, updated_at: at.toISOString(), managed_by_instance: false },
    });
  });

  it('without one, each scope is its own partition and may set its own key', () => {
    const { svc } = service(randomBytes(32).toString('base64url'));
    expect(svc.composioManagedByInstance()).toBe(false);
    expect(svc.composioPartition(user)).toBe(`u:${user.userId}`);
    expect(svc.composioPartition(org)).toBe(`o:${org.orgId}`);
    expect(() => svc.assertWritable('composio_api_key')).not.toThrow();
  });
});
