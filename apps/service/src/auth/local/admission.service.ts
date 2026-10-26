import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { newId, now } from '../../database/ids';
import { UserEntity } from '../../database/entities/user.entity';
import { UserIdentityEntity } from '../../database/entities/user-identity.entity';
import { UserSettingsEntity } from '../../database/entities/user-settings.entity';
import { rawQuery } from '../../database/raw-query';
import { EventsService } from '../../events/events.service';
import { OrgsService } from '../../orgs/orgs.service';
import { ADMISSION_LOCK_SPACE } from './admission-lock';

/** An account about to be created; `email` is already normalized. */
export interface NewAccount {
  email: string;
  name: string;
  hashedPassword: string | null;
  /** Whether an invite may be matched to `email`: false only for an address single sign-on's provider did not confirm. */
  emailVerified: boolean;
  /** The single sign-on identity it signs in with, or null for a password account. */
  identity: { issuer: string; subject: string; emailAtLink: string | null } | null;
}

/** The one place a first-party account is born; admissions take turns on one advisory lock, so two first-run sign-ups cannot both see an empty instance. */
@Injectable()
export class AdmissionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orgs: OrgsService,
    private readonly events: EventsService,
  ) {}

  /** Run `work` in one transaction as the only admission in flight; its lock is taken before any other. */
  admitting<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock($1, 0)', [ADMISSION_LOCK_SPACE]);
      return work(em);
    });
  }

  async isFirstAccount(em: EntityManager): Promise<boolean> {
    return (await em.count(UserEntity)) === 0;
  }

  async emailTaken(em: EntityManager, email: string): Promise<boolean> {
    const rows = await rawQuery(em, 'SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    return rows.length > 0;
  }

  /** The user, their settings row, their personal org and, for single sign-on, their identity — in the caller's admission. */
  async createAccount(em: EntityManager, account: NewAccount): Promise<UserEntity> {
    const user = em.create(UserEntity, {
      id: newId(),
      email: account.email,
      name: account.name,
      clerkUserId: null,
      hashedPassword: account.hashedPassword,
      emailVerified: account.emailVerified,
      createdAt: now(),
      updatedAt: now(),
    });
    await em.save(UserEntity, user);
    await em.insert(UserSettingsEntity, { id: newId(), userId: user.id });
    const org = await this.orgs.ensurePersonalOrg(em, user);
    if (account.identity) {
      await em.insert(UserIdentityEntity, {
        id: newId(),
        userId: user.id,
        issuer: account.identity.issuer,
        subject: account.identity.subject,
        emailAtLink: account.identity.emailAtLink,
        createdAt: now(),
        lastLoginAt: now(),
      });
    }
    await this.events.emit(em, {
      orgId: org.id,
      actorUserId: user.id,
      type: 'user.provisioned',
      subjectType: 'user',
      subjectId: user.id,
      payload: { method: account.identity ? 'oidc' : 'password' },
    });
    return user;
  }
}
