import type { EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { EnvironmentEntity } from '../database/entities/environment.entity';
import { admitEnvName, canonicalEnvName } from './env-name';

/** The org's environment by canonicalized name, or null; `lock` holds it FOR SHARE until the caller commits. */
export function findEnvironmentByName(
  em: EntityManager,
  orgId: string,
  rawName: string,
  lock = false,
): Promise<EnvironmentEntity | null> {
  const query = em
    .createQueryBuilder(EnvironmentEntity, 'e')
    .where('e.org_id = :orgId', { orgId })
    .andWhere('lower(e.name) = :name', { name: canonicalEnvName(rawName) });
  return (lock ? query.setLock('pessimistic_read') : query).getOne();
}

/** {@link findEnvironmentByName}, refusing 404 when the workspace has no environment of that name (a reserved name says why); never creates one. */
export async function environmentByName(
  em: EntityManager,
  orgId: string,
  rawName: string,
  lock = false,
): Promise<EnvironmentEntity> {
  const env = await findEnvironmentByName(em, orgId, rawName, lock);
  if (env) return env;
  const name = canonicalEnvName(rawName);
  const admitted = admitEnvName(name);
  throw new DomainError(
    'refusal' in admitted
      ? admitted.refusal
      : `This workspace has no environment named '${name}' — create it under Integrations → Environments first`,
    404,
    { code: 'environment_not_found' },
  );
}
