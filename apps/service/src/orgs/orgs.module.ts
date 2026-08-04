import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ConnectionsModule } from '../connections/connections.module';
import { ClustersController } from './clusters.controller';
import { ConsoleEmailAdapter, EMAIL_ADAPTER } from './email.adapter';
import { OrgManagementService } from './org-management.service';
import { InvitePreviewController } from './invite-preview.controller';
import { OrgsController } from './orgs.controller';

/** The org admin HTTP surface; the OrgsService tenancy primitive itself lives in the global CoreModule. */
@Module({
  imports: [AuthModule, ConnectionsModule],
  controllers: [OrgsController, ClustersController, InvitePreviewController],
  providers: [OrgManagementService, { provide: EMAIL_ADAPTER, useClass: ConsoleEmailAdapter }],
  exports: [OrgManagementService],
})
export class OrgsModule {}
