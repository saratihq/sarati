import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ComposeModule } from '../compose/compose.module';
import { ConnectionsModule } from '../connections/connections.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { RunsModule } from '../runs/runs.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { McpController } from './mcp.controller';
import { LiveRunConsentService } from './live-run-consent.service';
import { WorkflowInvokeTool } from './workflow-invoke.tool';
import { WorkflowToolsService } from './workflow-tools.service';
import { McpHandlerService } from './mcp-handler.service';
import { MCP_TOOLS, type McpTool } from './mcp-tool';
import { CommitTool } from './tools/commit.tool';
import { ContextTool } from './tools/context.tool';
import { CreateBranchTool } from './tools/create-branch.tool';
import { CreateWorkflowTool } from './tools/create-workflow.tool';
import { DescribeActionTool } from './tools/describe-action.tool';
import { DiffTool } from './tools/diff.tool';
import { EditWorkflowTool } from './tools/edit-workflow.tool';
import { GetRunTool } from './tools/get-run.tool';
import { GetWorkflowTool } from './tools/get-workflow.tool';
import { ListConnectionsTool } from './tools/list-connections.tool';
import { ListWorkflowsTool } from './tools/list-workflows.tool';
import { OpenReviewTool } from './tools/open-review.tool';
import { SearchActionsTool } from './tools/search-actions.tool';
import { TestWorkflowTool } from './tools/test-workflow.tool';
import { ValidateTool } from './tools/validate.tool';

/** Registration order is irrelevant — the handler sorts by name so `tools/list` is stable (ADR 0052). */
const TOOLS = [
  ContextTool,
  SearchActionsTool,
  DescribeActionTool,
  ListWorkflowsTool,
  GetWorkflowTool,
  DiffTool,
  GetRunTool,
  ListConnectionsTool,
  ValidateTool,
  EditWorkflowTool,
  CreateWorkflowTool,
  CommitTool,
  CreateBranchTool,
  OpenReviewTool,
  TestWorkflowTool,
];

@Module({
  imports: [
    AuthModule,
    EnvironmentsModule,
    WorkflowsModule,
    ComposeModule,
    ConnectionsModule,
    RunsModule,
    ReviewsModule,
  ],
  controllers: [McpController],
  providers: [
    ...TOOLS,
    LiveRunConsentService,
    WorkflowToolsService,
    WorkflowInvokeTool,
    { provide: MCP_TOOLS, useFactory: (...tools: McpTool[]) => tools, inject: [...TOOLS] },
    McpHandlerService,
  ],
})
export class McpModule {}
