import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { UserProvisioningService } from '../../src/auth/user-provisioning.service';

import {
  PlatformKeysService,
  type PlatformKeyName,
  type PlatformKeyScope,
} from '../../src/platform/platform-keys.service';

/**
 * Store a platform key for a scope on a booted app. The store is the only source for these
 * keys, so a suite that needs the managed rail on has to write one — setting env does nothing.
 */
export async function setPlatformKey(
  app: INestApplication,
  scope: PlatformKeyScope,
  name: PlatformKeyName,
  value: string,
): Promise<void> {
  await app.get(PlatformKeysService).set(scope, name, value);
}

/**
 * Seed a key for EVERY user and org in the (isolated) test database — for suites whose subject
 * is the managed rail's behaviour, not who owns the key. Scope-ownership itself is covered by
 * `platform-keys.e2e-spec.ts`, which sets keys deliberately per scope.
 */
export async function seedPlatformKeyEverywhere(
  app: INestApplication,
  name: PlatformKeyName,
  value: string,
): Promise<void> {
  const keys = app.get(PlatformKeysService);
  const ds = app.get(DataSource);
  // Under MOCK_AUTH the caller is provisioned lazily on first request, so make sure it exists
  // before seeding — otherwise the suite's own user has no key and the rail reads as off.
  await app.get(UserProvisioningService).getOrCreateMockUser();
  const users: Array<{ id: string }> = await ds.query(`SELECT id FROM users`);
  const orgs: Array<{ id: string }> = await ds.query(`SELECT id FROM organizations WHERE NOT is_personal`);
  for (const u of users) await keys.set({ kind: 'user', userId: u.id }, name, value);
  for (const o of orgs) await keys.set({ kind: 'org', orgId: o.id }, name, value);
}
