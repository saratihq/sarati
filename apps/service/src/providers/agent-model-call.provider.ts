import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  agentModelAuth,
  callAgentModel,
  type FetchLike,
  HttpClient,
  type Transport,
} from '@sarati/actions-sdk';

import { ComposioProvider } from '../connections/composio.provider';
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
import type { AgentModelAuth, AgentModelPort, ModelCallRequest, ModelTurn } from '../runtime/agent';
import { resolveSdkAuthHandle } from './sdk-auth';

/** Test-only fetch in place of the agent model call's network hop: the SDK's SSRF-guarded one for a direct credential, `composioFetch`'s for a managed one. */
export const AGENT_MODEL_FETCH = Symbol('AGENT_MODEL_FETCH');

/**
 * The production {@link AgentModelPort} — binds the AI Agent node's model seam to the SDK's tool-aware
 * `callAgentModel`, resolving the connection through {@link resolveSdkAuthHandle} and returning the normalized turn.
 * Not a catalog action and stateless, so one instance serves every agent run.
 */
@Injectable()
export class AgentModelCallProvider implements AgentModelPort {
  private readonly http = new HttpClient();

  constructor(
    private readonly connections: ConnectionsService,
    @Optional() @Inject(AGENT_MODEL_FETCH) private readonly fetchImpl?: FetchLike,
    @Optional() private readonly platformKeys?: PlatformKeysService,
    @Optional() private readonly composio?: ComposioProvider,
  ) {}

  /** The managed transport for the model connection, under the run's own scope's key. */
  private async managedTransport(
    auth: AgentModelAuth,
    connectedAccountId: string,
    personId: string,
  ): Promise<Transport | null> {
    if (!this.platformKeys || !this.composio) return null;
    const scope = await this.platformKeys.scopeFor(auth.externalUserId, auth.orgId ?? null);
    return this.composio.proxyTransportFor(scope, connectedAccountId, personId, this.fetchImpl);
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
        managedTransport: (accountId, personId) => this.managedTransport(auth, accountId, personId),
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
