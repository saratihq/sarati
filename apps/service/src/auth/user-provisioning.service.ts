import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { newId, now } from '../database/ids';
import { UserEntity } from '../database/entities/user.entity';
import { UserSettingsEntity } from '../database/entities/user-settings.entity';
import { rawMutateReturning } from '../database/raw-query';
import { EventsService } from '../events/events.service';
import { OrgsService } from '../orgs/orgs.service';
import { fetchClerkUser, placeholderIdentity, profileToIdentity, type ClerkIdentity } from './clerk-profile';
import { verifyPassword } from './local/password';
import { isUniqueViolation } from '../database/pg-errors';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

/** First-sight provisioning: a verified session yields its own user (a placeholder identity if Clerk is down), never another account. */
@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly orgs: OrgsService,
    private readonly events: EventsService,
  ) {}

  async getOrProvision(clerkUserId: string): Promise<UserEntity> {
    const existing = await this.findByClerkId(clerkUserId);
    if (existing) return existing;

    const identity = (await this.clerkIdentity(clerkUserId)) ?? placeholderIdentity(clerkUserId);
    return this.provision(clerkUserId, identity, identity.canLink);
  }

  /** Provision from an OIDC token's own claims — `subject` shares the external-subject column with Clerk. */
  async getOrProvisionFromClaims(subject: string, email: string, name: string): Promise<UserEntity> {
    const existing = await this.findByClerkId(subject);
    if (existing) return existing;
    return this.provision(subject, { email, name });
  }

  /** Link a Clerk user to the account their verified primary email names, once they prove that account's password. */
  async linkByPassword(clerkUserId: string, password: string): Promise<UserEntity> {
    const identity = await this.clerkIdentity(clerkUserId);
    if (!identity) {
      throw new DomainError('Clerk could not be reached to confirm your email address — try again.', 502, {
        code: 'clerk_unavailable',
      });
    }
    if (!identity.canLink) {
      throw new DomainError(
        'Clerk has not verified your primary email address, so it cannot link an account.',
        403,
        { code: 'email_unverified' },
      );
    }
    const [account, ...others] = await this.emailHolders(identity.email);
    if (!account || others.length > 0) {
      throw new DomainError(`No single account here uses ${identity.email}.`, 404, {
        code: 'no_account_to_link',
      });
    }
    if (!(await verifyPassword(password, account.hashedPassword))) {
      throw new DomainError(`That password does not match the account for ${identity.email}.`, 401, {
        code: 'invalid_credentials',
      });
    }

    try {
      await this.dataSource.transaction(async (em) => {
        const bound = await rawMutateReturning<{ id: string }>(
          em,
          `UPDATE users SET clerk_user_id = $1, updated_at = now()
            WHERE id = $2 AND clerk_user_id IS NULL RETURNING id`,
          [clerkUserId, account.id],
        );
        if (bound.length === 0) {
          throw new DomainError('That account already signs in through another Clerk user.', 409, {
            code: 'account_already_linked',
          });
        }
        const org = await this.orgs.ensurePersonalOrg(em, account);
        await this.events.emit(em, {
          orgId: org.id,
          actorUserId: account.id,
          type: 'user.adopted',
          subjectType: 'user',
          subjectId: account.id,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('This Clerk sign-in already has an account here.', 409, {
          code: 'clerk_already_linked',
        });
      }
      throw err;
    }
    return this.reload(account.id);
  }

  /** Create user + settings + personal org; race-safe. An email another account holds refuses, never adopts. */
  private async provision(
    clerkUserId: string,
    identity: { email: string; name: string },
    canLink = false,
  ): Promise<UserEntity> {
    const holders = await this.emailHolders(identity.email);
    if (holders.length > 0) throw emailTaken(identity.email, holders, canLink);
    try {
      return await this.dataSource
        .transaction(async (em) => {
          const user = em.create(UserEntity, {
            id: newId(),
            email: identity.email,
            name: identity.name,
            clerkUserId,
            hashedPassword: null,
            createdAt: now(),
            updatedAt: now(),
          });
          await em.save(UserEntity, user);
          await em.insert(UserSettingsEntity, { id: newId(), userId: user.id });
          const org = await this.orgs.ensurePersonalOrg(em, user);
          await this.events.emit(em, {
            orgId: org.id,
            actorUserId: user.id,
            type: 'user.provisioned',
            subjectType: 'user',
            subjectId: user.id,
          });
          return user;
        })
        .then((u) => this.reload(u.id));
    } catch (err) {
      // First-load race: parallel misses all insert; one wins the unique constraint, losers re-read.
      if (isUniqueViolation(err)) {
        const winner = await this.findByClerkId(clerkUserId);
        if (winner) return winner;
        throw emailTaken(identity.email, await this.emailHolders(identity.email), canLink);
      }
      throw err;
    }
  }

  private async clerkIdentity(clerkUserId: string): Promise<ClerkIdentity | null> {
    const env = this.config.get('env', { infer: true });
    try {
      return profileToIdentity(
        await fetchClerkUser(env.clerkApiUrl, clerkUserId, env.clerkSecretKey),
        clerkUserId,
      );
    } catch (err) {
      this.logger.warn(`Clerk profile fetch failed for ${clerkUserId}: ${errorMessage(err)}`);
      return null;
    }
  }

  // Case-insensitive: local accounts store the address lowercased, Clerk ones as Clerk gives it.
  private emailHolders(email: string): Promise<UserEntity[]> {
    return this.dataSource.manager
      .createQueryBuilder(UserEntity, 'u')
      .where('lower(u.email) = lower(:email)', { email })
      .getMany();
  }

  /** The fixed-id user MOCK_AUTH (dev/test mode) authenticates as. */
  async getOrCreateMockUser(): Promise<UserEntity> {
    const existing = await this.findById(MOCK_USER_ID);
    if (existing) return existing;

    return this.dataSource
      .transaction(async (em) => {
        const user = em.create(UserEntity, {
          id: MOCK_USER_ID,
          email: 'test@example.com',
          name: 'Test User',
          clerkUserId: null,
          hashedPassword: 'mock',
          createdAt: now(),
          updatedAt: now(),
        });
        await em.save(UserEntity, user);
        await em.insert(UserSettingsEntity, { id: newId(), userId: user.id });
        await this.orgs.ensurePersonalOrg(em, user);
        return user;
      })
      .then((u) => this.reload(u.id))
      .catch(async (err: unknown) => {
        if (isUniqueViolation(err)) {
          const winner = await this.findById(MOCK_USER_ID);
          if (winner) return winner;
        }
        throw err;
      });
  }

  private findByClerkId(clerkUserId: string): Promise<UserEntity | null> {
    return this.dataSource.manager.findOne(UserEntity, {
      where: { clerkUserId },
      relations: { settings: true },
    });
  }

  private findById(id: string): Promise<UserEntity | null> {
    return this.dataSource.manager.findOne(UserEntity, {
      where: { id },
      relations: { settings: true },
    });
  }

  /** Load a fully-hydrated user by local id (API-key auth path — no provisioning). */
  getById(id: string): Promise<UserEntity | null> {
    return this.findById(id);
  }

  private async reload(id: string): Promise<UserEntity> {
    const user = await this.findById(id);
    if (!user)
      throw new UnauthorizedException({ detail: 'User provisioning failed', code: 'provisioning_failed' });
    return user;
  }
}

// A link offer only when the email is a verified primary and exactly one unlinked account holds it.
function emailTaken(email: string, holders: UserEntity[], canLink: boolean): UnauthorizedException {
  const [holder, ...others] = holders;
  if (canLink && holder?.clerkUserId === null && others.length === 0) {
    return new UnauthorizedException({
      detail: `An account for ${email} already exists here. Enter its password to link it to this sign-in.`,
      code: 'account_link_required',
      email,
    });
  }
  return new UnauthorizedException({
    detail: `Another account here already uses ${email}, so this sign-in cannot make one. Ask an owner of this instance for help.`,
    code: 'provisioning_failed',
  });
}

export type { EntityManager };
