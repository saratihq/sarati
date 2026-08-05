import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, type EntityManager } from 'typeorm';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { newId, now } from '../database/ids';
import { UserEntity } from '../database/entities/user.entity';
import { UserSettingsEntity } from '../database/entities/user-settings.entity';
import { EventsService } from '../events/events.service';
import { OrgsService } from '../orgs/orgs.service';
import { fetchClerkUser, placeholderIdentity, profileToIdentity } from './clerk-profile';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';
const PG_UNIQUE_VIOLATION = '23505';

/** First-sight provisioning: a verified session always yields a user (placeholder identity if Clerk is down). */
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

    const env = this.config.get('env', { infer: true });
    let identity: { email: string; name: string };
    try {
      identity = profileToIdentity(await fetchClerkUser(clerkUserId, env.clerkSecretKey), clerkUserId);
    } catch (err) {
      this.logger.warn(`Clerk profile fetch failed for ${clerkUserId}: ${errorMessage(err)}`);
      identity = placeholderIdentity(clerkUserId);
    }

    return this.provision(clerkUserId, identity);
  }

  /** Provision from an OIDC token's own claims — `subject` shares the external-subject column with Clerk. */
  async getOrProvisionFromClaims(subject: string, email: string, name: string): Promise<UserEntity> {
    const existing = await this.findByClerkId(subject);
    if (existing) return existing;
    return this.provision(subject, { email, name });
  }

  /** Adopt-by-email or create user + settings + personal org; race-safe. */
  private async provision(
    clerkUserId: string,
    identity: { email: string; name: string },
  ): Promise<UserEntity> {
    try {
      return await this.dataSource
        .transaction(async (em) => {
          // Adopt a same-email password-era row (workflows and settings carry over) rather than duplicate it.
          const legacy = await em.findOne(UserEntity, {
            where: { email: identity.email, clerkUserId: IsNull() },
          });
          if (legacy) {
            legacy.clerkUserId = clerkUserId;
            legacy.updatedAt = now();
            await em.save(legacy);
            const org = await this.orgs.ensurePersonalOrg(em, legacy);
            await this.events.emit(em, {
              orgId: org.id,
              actorUserId: legacy.id,
              type: 'user.adopted',
              subjectType: 'user',
              subjectId: legacy.id,
            });
            return legacy;
          }

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
      if (this.isUniqueViolation(err)) {
        const winner = await this.findByClerkId(clerkUserId);
        if (winner) return winner;
        throw new UnauthorizedException({ detail: 'User provisioning failed' });
      }
      throw err;
    }
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
        if (this.isUniqueViolation(err)) {
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
    if (!user) throw new UnauthorizedException({ detail: 'User provisioning failed' });
    return user;
  }

  private isUniqueViolation(err: unknown): boolean {
    const driverErr = (err as { driverError?: { code?: string }; code?: string }) ?? {};
    return driverErr.driverError?.code === PG_UNIQUE_VIOLATION || driverErr.code === PG_UNIQUE_VIOLATION;
  }
}

export type { EntityManager };
