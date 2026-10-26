import { createHash, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../../common/domain-error';
import { randomToken } from '../../common/pkce';
import type { EnvConfig } from '../../config/env.config';
import { newId, now } from '../../database/ids';
import { OidcLoginStateEntity, type OidcFlowPurpose } from '../../database/entities/oidc-login-state.entity';
import { UserIdentityEntity } from '../../database/entities/user-identity.entity';
import { UserEntity } from '../../database/entities/user.entity';
import { rawMutate, rawMutateReturning, rawQuery } from '../../database/raw-query';
import { EventsService } from '../../events/events.service';
import { OrgManagementService } from '../../orgs/org-management.service';
import { OrgsService } from '../../orgs/orgs.service';
import { AdmissionService } from '../local/admission.service';
import { cleanName, grantSession, normalizeEmail, type SessionGrant } from '../local/local-auth.service';
import { verifyPassword } from '../local/password';
import {
  type IdpClaims,
  type LoadedDiscovery,
  OidcRejectedError,
  OidcRelyingParty,
  OidcStaleSignInError,
  OidcUnavailableError,
} from './oidc-relying-party';
import { UNCONNECTED_ACCOUNTS_SQL } from './unconnected-accounts';

const STATE_TTL_MS = 10 * 60_000;
const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 255;

/** What the browser needs to send the person to their identity provider. */
export interface FlowStart {
  authorize_url: string;
  state: string;
}

/** The callback's answer, exactly as the identity provider sent it to the tab that started the flow. */
export interface FlowAnswer {
  code: string;
  state: string;
  binding: string;
  iss?: string;
}

interface ConsumedState {
  nonce: string;
  code_verifier: string;
  binding_hash: string;
  purpose: OidcFlowPurpose;
  user_id: string | null;
  invite_token: string | null;
  created_at: Date;
  expires_at: Date;
}

function refusal(status: number, code: string, detail: string): DomainError {
  return new DomainError(detail, status, { code });
}

const stateInvalid = (): DomainError =>
  refusal(
    400,
    'oidc_state_invalid',
    'This sign-in expired, was already used, or started in another tab — start again.',
  );

function hashOf(value: string, encoding: 'hex' | 'base64url'): string {
  return createHash('sha256').update(value).digest(encoding);
}

function bindingMatches(binding: string, bindingHash: string): boolean {
  const presented = Buffer.from(hashOf(binding, 'base64url'));
  const held = Buffer.from(bindingHash);
  return presented.length === held.length && timingSafeEqual(presented, held);
}

function usableEmail(raw: string | null): string | null {
  const email = raw === null ? '' : normalizeEmail(raw);
  const shaped = /^[^\s@]+@[^\s@]+$/.test(email) && !/[\p{Cc}\p{Cf}]/u.test(email);
  return shaped && email.length <= MAX_EMAIL_LENGTH ? email : null;
}

function displayName(claims: IdpClaims, email: string): string {
  const local = email.split('@')[0] ?? email;
  const chosen = cleanName(claims.name ?? '') || cleanName(claims.preferredUsername ?? '') || local;
  return chosen.slice(0, MAX_NAME_LENGTH).trim();
}

// An account with a password keeps the address it signs in by; one without follows its provider's confirmed email.
function addressToTake(user: UserEntity, claims: IdpClaims, email: string | null): string | null {
  if (!claims.emailVerified || email === null) return null;
  if (user.email.toLowerCase() === email) return user.emailVerified ? null : user.email;
  return user.hashedPassword ? null : email;
}

/** Browser single sign-on: an identity is keyed by (issuer, subject), an email never links or adopts an account, and org membership comes only from an invite. */
@Injectable()
export class OidcSignInService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OidcSignInService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly rp: OidcRelyingParty,
    private readonly admission: AdmissionService,
    private readonly orgManagement: OrgManagementService,
    private readonly orgs: OrgsService,
    private readonly events: EventsService,
  ) {}

  private get env(): EnvConfig {
    return this.config.get('env', { infer: true });
  }

  /** Point the operator at the accounts from before single sign-on that a first sign-in would duplicate. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.oidcSignInEnabled) return;
    const [row] = await rawQuery<{ n: number }>(
      this.dataSource.manager,
      `SELECT count(*)::int AS n FROM (${UNCONNECTED_ACCOUNTS_SQL}) AS waiting`,
      [this.env.oidcIssuer],
    );
    const n = row?.n ?? 0;
    if (n === 0) return;
    const one = n === 1;
    this.logger.warn(
      `${n} ${one ? 'account' : 'accounts'} from before single sign-on ${one ? 'is' : 'are'} not connected to it — a first sign-in by ${one ? 'its owner' : 'one of their owners'} makes a new, empty account. Connect ${one ? 'it' : 'them'} with sarati-link-sso; sarati-link-sso --list names ${one ? 'it' : 'them'}.`,
    );
  }

  async start(input: { bindingHash: string; inviteToken?: string }): Promise<FlowStart> {
    this.assertEnabled();
    return this.begin({
      purpose: 'sign_in',
      userId: null,
      inviteToken: input.inviteToken?.trim() || null,
      bindingHash: input.bindingHash,
    });
  }

  async complete(answer: FlowAnswer): Promise<SessionGrant> {
    this.assertEnabled();
    const flow = await this.consume(answer, 'sign_in', null);
    const claims = await this.redeem(answer, flow);
    const email = this.admitted(claims);
    const { user, joined } = await this.enter(claims, email, flow.invite_token);
    return grantSession(user, this.env.secretKey, { method: 'oidc', idp: this.env.oidcIssuer }, joined);
  }

  /** Connect the provider to an existing account: the caller's live session, plus its password when it has one. */
  async linkStart(
    user: UserEntity,
    input: { bindingHash: string; currentPassword?: string },
  ): Promise<FlowStart> {
    this.assertEnabled();
    if (user.hashedPassword && !(await verifyPassword(input.currentPassword ?? '', user.hashedPassword))) {
      throw refusal(401, 'invalid_credentials', 'That password does not match this account.');
    }
    if (await this.identityOf(this.dataSource.manager, user.id)) throw this.alreadyLinked();
    return this.begin({
      purpose: 'link',
      userId: user.id,
      inviteToken: null,
      bindingHash: input.bindingHash,
    });
  }

  async linkComplete(
    user: UserEntity,
    answer: FlowAnswer,
  ): Promise<{ connected: true; email: string | null }> {
    this.assertEnabled();
    const flow = await this.consume(answer, 'link', user.id);
    const claims = await this.redeem(answer, flow);
    const email = this.admitted(claims);
    const issuer = this.env.oidcIssuer;
    await this.admission.admitting(async (em) => {
      const holder = await em.findOne(UserIdentityEntity, { where: { issuer, subject: claims.subject } });
      if (holder) throw holder.userId === user.id ? this.alreadyLinked() : this.identityInUse();
      if (await this.identityOf(em, user.id)) throw this.alreadyLinked();
      await em.insert(UserIdentityEntity, {
        id: newId(),
        userId: user.id,
        issuer,
        subject: claims.subject,
        emailAtLink: email,
        createdAt: now(),
        lastLoginAt: null,
      });
      await this.emitFor(em, user.id, 'user.identity_linked', { issuer });
    });
    return { connected: true, email };
  }

  /** Disconnect the provider — refused when it is the account's only way in. */
  async unlink(user: UserEntity): Promise<void> {
    this.assertEnabled();
    if (!user.hashedPassword || !this.env.localAuthEnabled) {
      throw refusal(
        409,
        'oidc_last_sign_in_method',
        'Single sign-on is the only way into this account, so it cannot be disconnected.',
      );
    }
    await this.dataSource.transaction(async (em) => {
      const removed = await rawMutate(em, 'DELETE FROM user_identities WHERE user_id = $1 AND issuer = $2', [
        user.id,
        this.env.oidcIssuer,
      ]);
      if (removed === 0)
        throw refusal(404, 'oidc_not_linked', 'Single sign-on is not connected to this account.');
      await this.emitFor(em, user.id, 'user.identity_unlinked', { issuer: this.env.oidcIssuer });
    });
  }

  private assertEnabled(): void {
    if (!this.env.oidcSignInEnabled) {
      throw refusal(404, 'oidc_disabled', 'Single sign-on is not configured on this instance.');
    }
  }

  private async begin(flow: {
    purpose: OidcFlowPurpose;
    userId: string | null;
    inviteToken: string | null;
    bindingHash: string;
  }): Promise<FlowStart> {
    const discovery = await this.viaProvider(() => this.rp.discovery());
    const state = randomToken(32);
    const nonce = randomToken(32);
    const codeVerifier = randomToken(32);
    const em = this.dataSource.manager;
    await rawMutate(em, 'DELETE FROM oidc_login_states WHERE expires_at < now()');
    await em.insert(OidcLoginStateEntity, {
      stateHash: hashOf(state, 'hex'),
      nonce,
      codeVerifier,
      bindingHash: flow.bindingHash,
      purpose: flow.purpose,
      userId: flow.userId,
      inviteToken: flow.inviteToken,
      createdAt: now(),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const reauthenticate = flow.purpose === 'link';
    return {
      authorize_url: this.rp.authorizeUrl(discovery, { state, nonce, codeVerifier, reauthenticate }),
      state,
    };
  }

  /** Spend the flow's state — single use, before any other check — and refuse it, indistinguishably, unless it is this flow's. */
  private async consume(
    answer: FlowAnswer,
    purpose: OidcFlowPurpose,
    userId: string | null,
  ): Promise<ConsumedState> {
    const [row] = await rawMutateReturning<ConsumedState>(
      this.dataSource.manager,
      `DELETE FROM oidc_login_states WHERE state_hash = $1
       RETURNING nonce, code_verifier, binding_hash, purpose, user_id, invite_token, created_at, expires_at`,
      [hashOf(answer.state, 'hex')],
    );
    const valid =
      row !== undefined &&
      new Date(row.expires_at).getTime() > Date.now() &&
      row.purpose === purpose &&
      row.user_id === userId &&
      bindingMatches(answer.binding, row.binding_hash);
    if (!valid) throw stateInvalid();
    return row;
  }

  private async redeem(answer: FlowAnswer, flow: ConsumedState): Promise<IdpClaims> {
    const discovery = await this.viaProvider(() => this.rp.discovery());
    return this.viaProvider(async () => {
      this.assertIssuer(discovery, answer.iss);
      return this.rp.redeem(discovery, {
        code: answer.code,
        codeVerifier: flow.code_verifier,
        nonce: flow.nonce,
        signedInSince: flow.purpose === 'link' ? new Date(flow.created_at) : undefined,
      });
    });
  }

  private assertIssuer(discovery: LoadedDiscovery, iss: string | undefined): void {
    if (iss === undefined) {
      if (discovery.issParameter) {
        throw new OidcRejectedError(
          'the authorization response carries no iss, though the provider advertises it (RFC 9207)',
        );
      }
      return;
    }
    if (iss !== this.env.oidcIssuer) {
      throw new OidcRejectedError(
        `the authorization response names issuer ${JSON.stringify(iss)}, not OIDC_ISSUER — a mix-up`,
      );
    }
  }

  /** The relying party's failures as the codes the client acts on; the exact reason goes to the operator log only. */
  private async viaProvider<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof OidcUnavailableError) {
        this.logger.warn(`Single sign-on unavailable: ${err.message}`);
        throw refusal(502, 'oidc_unavailable', 'The identity provider could not be reached — try again.');
      }
      if (err instanceof OidcStaleSignInError) {
        this.logger.warn(`Single sign-on refused: ${err.message}`);
        throw refusal(
          401,
          'oidc_reauthentication_required',
          'Your identity provider did not ask you to sign in again, so single sign-on was not connected — sign out at the provider, then connect again.',
        );
      }
      if (err instanceof OidcRejectedError) {
        this.logger.warn(`Single sign-on refused: ${err.message}`);
        throw refusal(
          401,
          'oidc_token_rejected',
          "The identity provider's answer could not be verified — try again.",
        );
      }
      throw err;
    }
  }

  /** The verified email when OIDC_ALLOWED_DOMAINS admits it, or whatever usable email there is when it is unset. */
  private admitted(claims: IdpClaims): string | null {
    const email = usableEmail(claims.email);
    const domains = this.env.oidcAllowedDomainList;
    if (domains.length === 0) return email;
    if (!claims.emailVerified) {
      throw refusal(
        403,
        'oidc_email_unverified',
        'Your identity provider did not confirm your email address (the email_verified claim), so this instance cannot check its domain.',
      );
    }
    if (!email) throw this.emailMissing();
    if (!domains.includes(email.slice(email.lastIndexOf('@') + 1))) {
      throw refusal(
        403,
        'oidc_domain_not_allowed',
        "Your email address's domain is not one this instance admits.",
      );
    }
    return email;
  }

  private async enter(
    claims: IdpClaims,
    email: string | null,
    inviteToken: string | null,
  ): Promise<{ user: UserEntity; joined: { org_id: string } | null }> {
    const known = await this.userOf(this.dataSource.manager, claims.subject);
    if (known) {
      const user = addressToTake(known, claims, email)
        ? await this.admission.admitting((em) => this.followProvider(em, known.id, claims, email))
        : known;
      return {
        user,
        joined: inviteToken ? await this.orgManagement.joinByInvite(user.id, inviteToken) : null,
      };
    }
    return this.admission.admitting(async (em) => {
      const raced = await this.userOf(em, claims.subject);
      if (raced) {
        const user = await this.followProvider(em, raced.id, claims, email);
        return {
          user,
          joined: inviteToken ? await this.orgManagement.acceptInviteWith(em, user.id, inviteToken) : null,
        };
      }
      if (!email) throw this.emailMissing();
      if (claims.emailVerified && (await this.admission.addressHeld(em, email))) {
        throw refusal(
          409,
          'oidc_account_exists',
          'An account with this email already exists. Sign in to it and connect single sign-on in Settings.',
        );
      }
      const first = await this.admission.isFirstAccount(em);
      const user = await this.admission.createAccount(em, {
        email,
        name: displayName(claims, email),
        hashedPassword: null,
        emailVerified: claims.emailVerified,
        identity: { issuer: this.env.oidcIssuer, subject: claims.subject, emailAtLink: email },
      });
      const joined = inviteToken ? await this.orgManagement.acceptInviteWith(em, user.id, inviteToken) : null;
      this.logger.log(
        `single sign-on account created for ${email}${first ? ' — the first on this instance' : ''}`,
      );
      return { user, joined };
    });
  }

  /** The account this subject signs in as at the configured issuer, its last sign-in recorded. */
  private async userOf(em: EntityManager, subject: string): Promise<UserEntity | null> {
    const identity = await em.findOne(UserIdentityEntity, {
      where: { issuer: this.env.oidcIssuer, subject },
    });
    if (!identity) return null;
    await em.update(UserIdentityEntity, { id: identity.id }, { lastLoginAt: now() });
    return em.findOneOrFail(UserEntity, { where: { id: identity.userId } });
  }

  /** Under the admission lock the caller holds, give the account the address {@link addressToTake} names unless another account holds it. */
  private async followProvider(
    em: EntityManager,
    userId: string,
    claims: IdpClaims,
    email: string | null,
  ): Promise<UserEntity> {
    const user = await em.findOneOrFail(UserEntity, { where: { id: userId } });
    const address = addressToTake(user, claims, email);
    if (!address || (await this.admission.addressHeld(em, address, user.id))) return user;
    const moved = address !== user.email;
    await em.update(UserEntity, { id: user.id }, { email: address, emailVerified: true, updatedAt: now() });
    if (moved) await this.emitFor(em, user.id, 'user.email_changed', { issuer: this.env.oidcIssuer });
    return Object.assign(user, { email: address, emailVerified: true });
  }

  private identityOf(em: EntityManager, userId: string): Promise<UserIdentityEntity | null> {
    return em.findOne(UserIdentityEntity, { where: { userId, issuer: this.env.oidcIssuer } });
  }

  private async emitFor(
    em: EntityManager,
    userId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const personal = await this.orgs.personalOrgOf(em, userId);
    await this.events.emit(em, {
      orgId: personal?.id ?? null,
      actorUserId: userId,
      type,
      subjectType: 'user',
      subjectId: userId,
      payload,
    });
  }

  private emailMissing(): DomainError {
    return refusal(
      403,
      'oidc_email_missing',
      'Your identity provider did not send a usable email address (the email claim) — ask your operator to release it.',
    );
  }

  private alreadyLinked(): DomainError {
    return refusal(409, 'oidc_already_linked', 'Single sign-on is already connected to this account.');
  }

  private identityInUse(): DomainError {
    return refusal(409, 'oidc_identity_in_use', 'That identity already signs in to another account.');
  }
}
