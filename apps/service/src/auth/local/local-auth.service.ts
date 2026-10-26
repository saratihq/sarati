import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../../common/domain-error';
import type { EnvConfig } from '../../config/env.config';
import { OrgInviteEntity } from '../../database/entities/org-invite.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { OrgManagementService } from '../../orgs/org-management.service';
import { AdmissionService } from './admission.service';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from './password';
import { mintSession, type SessionMethod } from './local-session';

/** A password never verified against a real hash still costs time, so login cannot be an account oracle. */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface SessionGrant {
  token: string;
  expires_at: string;
  user: { id: string; email: string; name: string };
  /** The org an invite carried through sign-in just joined, so the client can open it. */
  joined_org_id?: string;
}

/** The refusal for a sign-up the instance does not admit — one answer, whatever the reason. */
export function signupClosed(): DomainError {
  return new DomainError('This instance is not open for signup — ask an owner for an invite link.', 403, {
    code: 'signup_closed',
  });
}

/** Email + password for self-host: bootstrap-or-invite registration, then signed sessions. */
@Injectable()
export class LocalAuthService {
  private readonly logger = new Logger(LocalAuthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly orgManagement: OrgManagementService,
    private readonly admission: AdmissionService,
  ) {}

  /** Whether this instance offers local login at all — the client asks before drawing a form. */
  get enabled(): boolean {
    return this.config.get('env', { infer: true }).localAuthEnabled;
  }

  /** Whether browser single sign-on is configured. */
  get ssoEnabled(): boolean {
    return this.config.get('env', { infer: true }).oidcSignInEnabled;
  }

  /** True while the instance has no users and a first-party sign-in can make its first account. */
  async awaitingBootstrap(): Promise<boolean> {
    const env = this.config.get('env', { infer: true });
    if (!env.localAuthEnabled && !env.oidcSignInEnabled) return false;
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
    const hashedPassword = await hashPassword(input.password);
    const inviteToken = input.inviteToken?.trim();

    return this.admission.admitting(async (em) => {
      await this.assertAdmissible(em, email, inviteToken);
      if (await this.admission.emailTaken(em, email)) {
        throw new DomainError('An account with that email already exists — sign in instead.', 409, {
          code: 'email_taken',
        });
      }

      const user = await this.admission.createAccount(em, {
        email,
        name: input.name?.trim() || email.split('@')[0] || 'Owner',
        hashedPassword,
        emailVerified: true,
        identity: null,
      });
      // Membership runs through the ONE acceptance path, so the join event fires exactly as it does for a browser accept.
      const joined = inviteToken ? await this.orgManagement.acceptInviteWith(em, user.id, inviteToken) : null;
      if (inviteToken && !joined) throw signupClosed();
      this.logger.log(`local account created for ${email}`);
      return grantSession(
        user,
        this.config.get('env', { infer: true }).secretKey,
        { method: 'password' },
        joined,
      );
    });
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
    return grantSession(
      user,
      this.config.get('env', { infer: true }).secretKey,
      { method: 'password' },
      null,
    );
  }

  /** Registration is never open: the FIRST account on an empty instance, or one matching a live invite. */
  private async assertAdmissible(em: EntityManager, email: string, token: string | undefined): Promise<void> {
    if (await this.admission.isFirstAccount(em)) return;

    const invite = token ? await em.findOne(OrgInviteEntity, { where: { token } }) : null;
    const live =
      invite !== null &&
      normalizeEmail(invite.email ?? '') === email &&
      (await this.orgManagement.isRedeemable(em, invite));
    if (!live) throw signupClosed();
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

/** A fresh session for `user`, minted for the method they signed in with. */
export async function grantSession(
  user: UserEntity,
  secret: string,
  via: SessionMethod,
  joined: { org_id: string } | null,
): Promise<SessionGrant> {
  const { token, expiresAt } = await mintSession(user.id, secret, via);
  return {
    token,
    expires_at: expiresAt,
    user: { id: user.id, email: user.email ?? '', name: user.name ?? '' },
    ...(joined ? { joined_org_id: joined.org_id } : {}),
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
