import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { agentModelAuth, callAgentModel, type FetchLike, HttpClient } from '@sarati/actions-sdk';

import { ConnectionsService } from '../connections/connections.service';
import {
  agentModelStep,
  connectionIdOf,
  isInlineCredential,
  noAccountMessage,
  resolveRunAs,
  type RunAsStep,
} from '../connections/run-as-account';
import { PlatformKeysService } from '../platform/platform-keys.service';
import type { EnvConfig } from '../config/env.config';
import type { AgentModelAuth, AgentModelPort, ModelCallRequest, ModelTurn } from '../runtime/agent';
import { resolveSdkAuthHandle } from './sdk-auth';

/** Test-only fetch for the agent model call; unset in production → the SDK's SSRF-guarded hop, which any value here skips. */
export const AGENT_MODEL_FETCH = Symbol('AGENT_MODEL_FETCH');

/**
 * The production {@link AgentModelPort} — binds the AI Agent node's model seam to the SDK's tool-aware
 * `callAgentModel`, resolving the connection through {@link resolveSdkAuthHandle} and returning the normalized turn.
 * Not a catalog action and stateless, so one instance serves every agent run.
 */
@Injectable()
export class AgentModelCallProvider implements AgentModelPort {
  private readonly composioBaseUrl: string;
  private readonly http = new HttpClient();

  constructor(
    config: ConfigService<{ env: EnvConfig }, true>,
    private readonly connections: ConnectionsService,
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
    const scheme = agentModelAuth[req.provider];
    if (!scheme) {
      throw new Error(`Agent model call: unsupported provider "${String(req.provider)}"`);
    }
    const step = agentModelStep(auth.stepName ?? 'AI Agent', req.provider, connectionIdOf(auth.connection));
    const resolved = await this.resolveModelConnection(step, auth);
    const handle = await resolveSdkAuthHandle(
      scheme,
      {
        externalUserId: resolved.externalUserId,
        auth: resolved.connection,
        connections: this.connections,
        composioApiKey: (await this.composioKeyFor(auth)) ?? '',
        composioBaseUrl: this.composioBaseUrl,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        decided: { step, where: auth },
      },
      noAccountMessage(step),
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

  private async resolveModelConnection(
    step: RunAsStep,
    auth: AgentModelAuth,
  ): Promise<{ connection: unknown; externalUserId: string }> {
    if (isInlineCredential(auth.connection)) {
      return { connection: auth.connection, externalUserId: auth.externalUserId };
    }
    const account = await resolveRunAs(step, auth, this.connections);
    return { connection: { connectionId: account.id }, externalUserId: account.ownerUserId };
  }
}
