import { Module } from '@nestjs/common';
import { FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectService } from './project.service.js';
import { ProjectsController } from './projects.controller.js';

@Module({ imports: [FoundationModule, AuthModule], controllers: [ProjectsController], providers: [ProjectService], exports: [ProjectService] })
export class ProjectsModule {}
