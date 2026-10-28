import type { EntityManager } from 'typeorm';

import { newId, now } from '../database/ids';
import { OrgMemberEntity, OrganizationEntity } from '../database/entities/organization.entity';
import { seedDefaultEnvironments } from '../environments/default-environments';

/** Insert an org with its owner and its default environments, in the caller's transaction; a personal org records its owner as the account it belongs to. */
export async function insertOrg(
  em: EntityManager,
  input: { name: string; isPersonal: boolean; ownerId: string },
): Promise<OrganizationEntity> {
  const org = em.create(OrganizationEntity, {
    id: newId(),
    name: input.name,
    isPersonal: input.isPersonal,
    personalOwnerId: input.isPersonal ? input.ownerId : null,
    createdAt: now(),
    updatedAt: now(),
  });
  await em.insert(OrganizationEntity, org);
  await em.insert(OrgMemberEntity, {
    id: newId(),
    orgId: org.id,
    userId: input.ownerId,
    role: 'owner',
    isPersonal: input.isPersonal,
    createdAt: now(),
  });
  await seedDefaultEnvironments(em, org.id);
  return org;
}
