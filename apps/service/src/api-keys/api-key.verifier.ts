import { Injectable } from '@nestjs/common';

import type { TokenVerifier, VerifiedIdentity } from '../auth/token-verifier';
import { ApiKeysService } from './api-keys.service';

/** The API-key auth strategy (ADR 0002): an `ork_` key resolves straight to its owner, other shapes are ignored. */
@Injectable()
export class ApiKeyVerifier implements TokenVerifier {
  readonly name = 'api-key';

  constructor(private readonly apiKeys: ApiKeysService) {}

  async verify(token: string): Promise<VerifiedIdentity | null> {
    if (!token.startsWith('ork_')) return null; // not our token shape
    const result = await this.apiKeys.verify(token);
    return result ? { userId: result.userId, apiKey: { scopes: result.scopes, orgId: result.orgId } } : null;
  }
}
