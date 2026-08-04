import { Module } from '@nestjs/common';

import { ConnectionsModule } from '../connections/connections.module';
import { ActionRouterProvider } from './action-router.provider';
import { AgentModelCallProvider, AGENT_MODEL_FETCH } from './agent-model-call.provider';
import { ComposioTriggerProvider } from './composio-trigger.provider';
import { MANAGED_INTEGRATION_PROVIDER } from './managed-integration-provider';
import { SdkActionsProvider, SDK_ACTIONS_FETCH } from './sdk-actions.provider';
import { RegistryAgentToolCatalog } from './registry-agent-tool-catalog';
import { SdkPollingProvider, SDK_POLLING_FETCH } from './sdk-polling.provider';
import { SdkWebhookProvider, SDK_WEBHOOK_FETCH } from './sdk-webhook.provider';
import { AGENT_MODEL_CALL, AGENT_TOOL_CATALOG } from '../runtime/agent';

/**
 * The action/trigger execution seam: the runtime binds `MANAGED_INTEGRATION_PROVIDER` to `ActionRouterProvider`,
 * which routes our clean-room actions first and Composio second. `SdkActionsProvider` is exported for the
 * catalog/inspector surfaces that address it directly.
 */
@Module({
  imports: [ConnectionsModule],
  providers: [
    SdkActionsProvider,
    ActionRouterProvider,
    SdkWebhookProvider,
    SdkPollingProvider,
    ComposioTriggerProvider,
    // The three SDK fetch seams: undefined in prod (the SDK uses the global fetch);
    // registered so tests can overrideProvider them with a stub.
    { provide: SDK_WEBHOOK_FETCH, useValue: undefined },
    { provide: SDK_POLLING_FETCH, useValue: undefined },
    { provide: SDK_ACTIONS_FETCH, useValue: undefined },
    { provide: MANAGED_INTEGRATION_PROVIDER, useExisting: ActionRouterProvider },
    RegistryAgentToolCatalog,
    { provide: AGENT_TOOL_CATALOG, useExisting: RegistryAgentToolCatalog },
    AgentModelCallProvider,
    { provide: AGENT_MODEL_CALL, useExisting: AgentModelCallProvider },
    { provide: AGENT_MODEL_FETCH, useValue: undefined },
  ],
  exports: [
    SdkActionsProvider,
    ActionRouterProvider,
    SdkWebhookProvider,
    SdkPollingProvider,
    ComposioTriggerProvider,
    MANAGED_INTEGRATION_PROVIDER,
    AGENT_TOOL_CATALOG,
    AGENT_MODEL_CALL,
  ],
})
export class ProvidersModule {}
