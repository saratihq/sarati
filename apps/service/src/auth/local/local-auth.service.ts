import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../../common/domain-error';
import type { EnvConfig } from '../../config/env.config';
import { newId, now } from '../../database/ids';
import { OrgInviteEntity } from '../../database/entities/org-invite.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { OrgManagementService } from '../../orgs/org-management.service';
import { OrgsService } from '../../orgs/orgs.service';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from './password';
import { mintSession } from './local-session';

/** A password never verified against a real hash still costs time, so login cannot be an account oracle. */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface SessionGrant {
  token: string;
  expires_at: string;
  user: { id: string; email: string; name: string };
}

/** Email + password for self-host (ADR 0054): bootstrap-or-invite registration, then signed sessions. */
@Injectable()
export class LocalAuthService {
  private readonly logger = new Logger(LocalAuthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly orgs: OrgsService,
    private readonly orgManagement: OrgManagementService,
  ) {}

  /** Whether this instance offers local login at all — the client asks before drawing a form. */
  get enabled(): boolean {
    return this.config.get('env', { infer: true }).localAuthEnabled;
  }

  /** True while the instance has no users: the first-run window in which an owner account is made. */
  async awaitingBootstrap(): Promise<boolean> {
    if (!this.enabled) return false;
    return (await this.dataSource.manager.count(UserEntity)) === 0;
  }

  async register(input: {
    email: string;
    password: string;
    name?: string;
    inviteToken?: string;
  }): Promise<SessionGrant> {
    this.assertEnabled();
    const email = normalizeEmail(input.email);
    this.assertPasswordUsable(input.password);

    const grant = await this.dataSource.transaction(async (em) => {
      await this.assertAdmissible(em, email, input.inviteToken);
      if (await em.findOne(UserEntity, { where: { email } })) {
        throw new DomainError('An account with that email already exists — sign in instead.', 409, {
          code: 'email_taken',
        });
      }

      const user = em.create(UserEntity, {
        id: newId(),
        email,
        name: input.name?.trim() || email.split('@')[0] || 'Owner',
        hashedPassword: await hashPassword(input.password),
        createdAt: now(),
        updatedAt: now(),
      });
      await em.save(UserEntity, user);
      await this.orgs.ensurePersonalOrg(em, user);
      this.logger.log(`local account created for ${email}`);
      return { session: await this.grant(user), userId: user.id };
    });

    // Membership runs through the ONE acceptance path, so the join event fires exactly as it does
    // for a browser accept. It owns its own transaction, hence after the commit above.
    if (input.inviteToken) await this.orgManagement.acceptInvite(grant.userId, input.inviteToken.trim());
    return grant.session;
  }

  async login(email: string, password: string): Promise<SessionGrant> {
    this.assertEnabled();
    const user = await this.dataSource.manager.findOne(UserEntity, {
      where: { email: normalizeEmail(email) },
    });
    // Hash even when the account is unknown, so the response time reveals nothing.
    const ok = await verifyPassword(password, user?.hashedPassword ?? DUMMY_HASH);
    if (!user || !ok) {
      throw new DomainError('That email and password do not match an account.', 401, {
        code: 'invalid_credentials',
      });
    }
    return this.grant(user);
  }

  private async grant(user: UserEntity): Promise<SessionGrant> {
    const { secretKey } = this.config.get('env', { infer: true });
    const { token, expiresAt } = await mintSession(user.id, secretKey);
    return {
      token,
      expires_at: expiresAt,
      user: { id: user.id, email: user.email ?? '', name: user.name ?? '' },
    };
  }

  /**
   * Registration is never open: the FIRST account on an empty instance, or one matching a live
   * invite. Returns the invite to accept, or null for the bootstrap case.
   */
  private async assertAdmissible(em: EntityManager, email: string, token: string | undefined): Promise<void> {
    if ((await em.count(UserEntity)) === 0) return;

    const invite = token ? await em.findOne(OrgInviteEntity, { where: { token: token.trim() } }) : null;
    const live =
      invite &&
      invite.acceptedBy === null &&
      normalizeEmail(invite.email ?? '') === email &&
      (!invite.expiresAt || invite.expiresAt.getTime() > Date.now());
    if (!live) {
      throw new DomainError('This instance is not open for signup — ask an owner for an invite link.', 403, {
        code: 'signup_closed',
      });
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new DomainError('This instance signs in through its identity provider.', 404, {
        code: 'local_auth_disabled',
      });
    }
  }

  private assertPasswordUsable(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new DomainError(
        `Use at least ${MIN_PASSWORD_LENGTH} characters — length matters more than symbols.`,
        400,
        { code: 'password_too_short' },
      );
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
