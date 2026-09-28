import { Module } from '@nestjs/common';
import { FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { WorkspacesController, WorkspaceInvitesController } from './workspaces.controller.js';
import { WorkspaceService } from './workspace.service.js';

@Module({ imports: [FoundationModule, AuthModule], controllers: [WorkspacesController, WorkspaceInvitesController], providers: [WorkspaceService] })
export class WorkspacesModule {}
