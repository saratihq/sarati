import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pool } from 'pg';

import type { EnvConfig } from '../config/env.config';
import { SchemaGuard } from './schema-guard';
import { ApiKeyEntity } from './entities/api-key.entity';
import { ComposioAuthConfigEntity } from './entities/composio-auth-config.entity';
import { ComposioWebhookDeliveryEntity } from './entities/composio-webhook-delivery.entity';
import { ConnectionEntity } from './entities/connection.entity';
import { DomainEventEntity } from './entities/domain-event.entity';
import { EnvironmentConnectionEntity, EnvironmentEntity } from './entities/environment.entity';
import { OrgInviteEntity } from './entities/org-invite.entity';
import { OrgMemberEntity, OrganizationEntity } from './entities/organization.entity';
import { ReviewApprovalEntity, ReviewCommentEntity, WorkflowReviewEntity } from './entities/review.entity';
import { NodeIconEntity } from './entities/node-icon.entity';
import { OAuthStateEntity } from './entities/oauth-state.entity';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity';
import { RuntimeBlobEntity } from './entities/runtime-blob.entity';
import { RuntimeRunEntity, RuntimeRunStepEntity } from './entities/runtime-run.entity';
import {
  RuntimeActivationStoreEntity,
  RuntimeTriggerActivationEntity,
} from './entities/runtime-trigger-activation.entity';
import { UserSettingsEntity } from './entities/user-settings.entity';
import { UserEntity } from './entities/user.entity';
import { WorkflowBranchEntity } from './entities/workflow-branch.entity';
import { WorkflowEntity } from './entities/workflow.entity';
import { WorkflowEnvPointerEntity } from './entities/workflow-env-pointer.entity';
import { WorkflowVersionEntity } from './entities/workflow-version.entity';
import { WorkflowVersionTagEntity } from './entities/workflow-version-tag.entity';
import { WebhookTriggerSecretEntity } from './entities/webhook-trigger-secret.entity';

import { PG_POOL } from './tokens';

export { PG_POOL };

export const ENTITIES = [
  UserEntity,
  UserSettingsEntity,
  OrganizationEntity,
  OrgMemberEntity,
  OrgInviteEntity,
  DomainEventEntity,
  ApiKeyEntity,
  ConnectionEntity,
  ComposioAuthConfigEntity,
  ComposioWebhookDeliveryEntity,
  EnvironmentEntity,
  EnvironmentConnectionEntity,
  WorkflowEntity,
  WorkflowBranchEntity,
  WorkflowVersionEntity,
  WorkflowVersionTagEntity,
  WebhookTriggerSecretEntity,
  WorkflowEnvPointerEntity,
  WorkflowReviewEntity,
  ReviewCommentEntity,
  ReviewApprovalEntity,
  NodeIconEntity,
  OAuthStateEntity,
  IdempotencyKeyEntity,
  RuntimeRunEntity,
  RuntimeRunStepEntity,
  RuntimeBlobEntity,
  RuntimeTriggerActivationEntity,
  RuntimeActivationStoreEntity,
];

@Injectable()
export class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Shared DB access against the live database. `synchronize: false` ALWAYS — entities are
 * hand-mapped to the DDL that `db/schema.sql` + `db/migrations/*.sql` own.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ env: EnvConfig }, true>) => {
        const env = config.get('env', { infer: true });
        return {
          type: 'postgres' as const,
          url: env.databaseUrl,
          entities: ENTITIES,
          synchronize: false,
          poolSize: 20,
        };
      },
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ env: EnvConfig }, true>): Pool => {
        const env = config.get('env', { infer: true });
        return new Pool({
          connectionString: env.databaseUrl,
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
      },
    },
    DatabaseShutdown,
    SchemaGuard,
  ],
  exports: [PG_POOL, TypeOrmModule],
})
export class DatabaseModule {}
