import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AuthModule } from './auth/auth.module';
import { LocalAuthModule } from './auth/local/local-auth.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { genRequestId } from './common/request-id';
import { validateEnv, type EnvConfig } from './config/env.config';
import { CoreModule } from './core.module';
import { DatabaseModule } from './database/database.module';
import { EnvironmentsModule } from './environments/environments.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { OrgsModule } from './orgs/orgs.module';
import { ReviewsModule } from './reviews/reviews.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { IconsModule } from './icons/icons.module';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { GenerationModule } from './generation/generation.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { ProvidersModule } from './providers/providers.module';
import { RuntimeModule } from './runtime/runtime.module';
import { DbosModule } from './dbos/dbos.module';
import { RunsModule } from './runs/runs.module';
import { TriggersModule } from './triggers/triggers.module';
import { ConnectionsModule } from './connections/connections.module';
import { ComposeModule } from './compose/compose.module';
import { SubWorkflowModule } from './sub-workflow/sub-workflow.module';
import { McpModule } from './mcp/mcp.module';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ env: validateEnv(process.env) })],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        // Reuse the id assigned by the early express middleware (main.ts);
        // fall back to generating one (unit tests that skip main's setup).
        genReqId: (req, res) => {
          const existing = (req as unknown as { id?: unknown }).id;
          return typeof existing === 'string' ? existing : genRequestId(req, res);
        },
        autoLogging: true,
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          censor: '[REDACTED]',
        },
        level: process.env.LOG_LEVEL ?? 'info',
      },
    }),
    // Keyed per client IP; X-Forwarded-For is honored only behind TRUST_PROXY_HEADERS (bootstrap.ts).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<{ env: EnvConfig }, true>) => {
        const env = config.get('env', { infer: true });
        return { throttlers: [{ ttl: env.throttleTtlMs, limit: env.throttleLimit }] };
      },
    }),
    DatabaseModule,
    CoreModule,
    JobsModule,
    AuthModule,
    LocalAuthModule,
    OrgsModule,
    WorkflowsModule,
    ReviewsModule,
    ApiKeysModule,
    IconsModule,
    GenerationModule,
    // Managed-integration providers (the SDK + Composio rails). The orchestration
    // runtime injects these to run workflow steps.
    ProvidersModule,
    // The IR interpreter (orchestration runtime).
    RuntimeModule,
    // DBOS durable execution (opt-in via DBOS_ENABLED).
    DbosModule,
    // The runtime's HTTP surface — POST /api/runs executes a plan.
    RunsModule,
    // Polling triggers fire embedded RunPlans.
    TriggersModule,
    // Managed-integration connections (credentials for actions).
    ConnectionsModule,
    // ADR 0014: named environments (slots over the per-user connection pool).
    EnvironmentsModule,
    // AI composer: draft apply-ops + catalog search for apps/agent.
    ComposeModule,
    // ADR 0045 §3 (feature A): the sub-workflow-as-tool runner (binds the interpreter seam).
    SubWorkflowModule,
    // ADR 0052: the Platform MCP surface (`/mcp`).
    McpModule,
    // The two optional platform API keys, set from Settings rather than the environment.
    PlatformModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
