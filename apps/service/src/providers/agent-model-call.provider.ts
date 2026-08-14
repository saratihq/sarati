import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ApiKeyScheme, callAgentModel, type FetchLike, HttpClient } from '@sarati/actions-sdk';

import { ConnectionsService } from '../connections/connections.service';
import { PlatformKeysService } from '../platform/platform-keys.service';
import { resolveEnvSlotConnection } from '../connections/env-slot-resolver';
import type { EnvConfig } from '../config/env.config';
import {
  type AgentModelAuth,
  type AgentModelPort,
  type AgentProvider,
  type ModelCallRequest,
  type ModelTurn,
} from '../runtime/agent';
import { resolveSdkAuthHandle } from './sdk-auth';

/** Optional fetch override for the agent model call's SDK transport; unset in production. */
export const AGENT_MODEL_FETCH = Symbol('AGENT_MODEL_FETCH');

/**
 * How each provider authenticates its REST API — must stay identical to the scheme the SDK's
 * `<provider>.generate_text` LLM nodes declare, so the agent resolves a BYO/managed key exactly as they do.
 */
const PROVIDER_AUTH: Record<AgentProvider, ApiKeyScheme> = {
  // Anthropic: raw key in `x-api-key` (no bearer prefix).
  claude: { type: 'apiKey', in: 'header', name: 'x-api-key' },
  // OpenAI: bearer key in `Authorization`.
  openai: { type: 'apiKey', in: 'header', name: 'Authorization', prefix: 'Bearer ' },
  // Mistral: bearer key in `Authorization` (OpenAI-shaped API).
  mistral: { type: 'apiKey', in: 'header', name: 'Authorization', prefix: 'Bearer ' },
  // Gemini: key as a `?key=` query parameter.
  gemini: { type: 'apiKey', in: 'query', name: 'key' },
};

/**
 * The production {@link AgentModelPort} (ADR 0045) — binds the AI Agent node's model seam to the SDK's tool-aware
 * `callAgentModel`, resolving the connection through {@link resolveSdkAuthHandle} and returning the normalized turn.
 * Not a catalog action and stateless, so one instance serves every agent run.
 */
@Injectable()
export class AgentModelCallProvider implements AgentModelPort {
  private readonly composioBaseUrl: string;
  private readonly http = new HttpClient();

  constructor(
    config: ConfigService<{ env: EnvConfig }, true>,
    // Optional so the provider stays `new`-able in unit tests without DI.
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() @Inject(AGENT_MODEL_FETCH) private readonly fetchImpl?: FetchLike,
    @Optional() private readonly platformKeys?: PlatformKeysService,
  ) {
    this.composioBaseUrl = config.get('env', { infer: true }).composioBaseUrl;
  }

  /** Whose Composio key brokers the model connection — the run's own scope. */
  private async composioKeyFor(auth: AgentModelAuth): Promise<string | undefined> {
    if (!this.platformKeys) return undefined;
    const scope = await this.platformKeys.scopeFor(auth.externalUserId, auth.orgId ?? null);
    return this.platformKeys.composioApiKey(scope);
  }

  async call(req: ModelCallRequest, auth: AgentModelAuth): Promise<ModelTurn> {
    const scheme = PROVIDER_AUTH[req.provider];
    if (!scheme) {
      throw new Error(`Agent model call: unsupported provider "${String(req.provider)}"`);
    }
    const resolved = await this.resolveModelConnection(req.provider, auth);
    const handle = await resolveSdkAuthHandle(
      scheme,
      {
        externalUserId: resolved.externalUserId,
        auth: resolved.connection,
        ...(this.connections ? { connections: this.connections } : {}),
        composioApiKey: (await this.composioKeyFor(auth)) ?? '',
        composioBaseUrl: this.composioBaseUrl,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      },
      `The ${req.provider} model call requires a ${req.provider} connection — attach one to the agent's model and retry`,
    );
    // ModelCallRequest and the SDK's AgentModelRequest are structurally identical by design — no remapping needed.
    const result = await callAgentModel(
      {
        provider: req.provider,
        model: req.model,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      },
      handle,
      this.http,
    );
    return {
      ...(result.text !== undefined ? { text: result.text } : {}),
      toolCalls: result.toolCalls,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  /**
   * The connection + tenant the model call runs on. In an ENV-scoped run the provider's env SLOT wins and the call
   * runs as its owner (action parity, ADR 0014); a Default run uses `auth.connection`, and a missing slot is a hard 428.
   */
  private async resolveModelConnection(
    provider: AgentProvider,
    auth: AgentModelAuth,
  ): Promise<{ connection: unknown; externalUserId: string }> {
    if (this.connections) {
      const slot = await resolveEnvSlotConnection(this.connections, auth, provider);
      if (slot) return { connection: { connectionId: slot.connectionId }, externalUserId: slot.ownerUserId };
    }
    return { connection: auth.connection, externalUserId: auth.externalUserId };
  }
}
