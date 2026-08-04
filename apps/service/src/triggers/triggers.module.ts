import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ConnectionsModule } from '../connections/connections.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { JobsModule } from '../jobs/jobs.module';
import { ProvidersModule } from '../providers/providers.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { CatchController } from './catch.controller';
import { CatchStore } from './catch-store';
import { ChatController } from './chat.controller';
import { RunsModule } from '../runs/runs.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { HooksController } from './hooks.controller';
import { TriggerPollerJob } from './trigger-poller.job';
import { TriggerReconcilerJob } from './canvas/trigger-reconciler.job';
import { TriggerReconcilerService } from './canvas/trigger-reconciler.service';
import { TriggerCatalogModule } from './trigger-catalog.module';
import { TriggerSignalsModule } from './trigger-signals.module';
import { TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';
import { WebhookSecretsController } from './webhook-secrets.controller';
import { WebhookSecretsService } from './webhook-secrets.service';

/**
 * Canvas triggers (ADR 0018): triggers are NODES in the version doc, activated by env promotion.
 * The reconciler (`canvas/*`) materializes the derived activations, the poll sweep fires the due
 * ones, and the public intakes live on `/api/hooks/<wf>/<env>` and `/api/chat/<wf>/<env>`.
 */
@Module({
  imports: [
    AuthModule,
    ProvidersModule,
    RunsModule,
    // RuntimeModule provides RuntimeCompiler — the ONE IR→plan compile seam (ADR 0023).
    RuntimeModule,
    JobsModule,
    WorkflowsModule,
    EnvironmentsModule,
    ConnectionsModule,
    TriggerSignalsModule,
    TriggerCatalogModule,
  ],
  controllers: [
    TriggersController,
    HooksController,
    ChatController,
    CatchController,
    WebhookSecretsController,
  ],
  providers: [
    TriggersService,
    TriggerPollerJob,
    CatchStore,
    TriggerReconcilerService,
    TriggerReconcilerJob,
    WebhookSecretsService,
  ],
})
export class TriggersModule {}
