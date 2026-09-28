import { ApiProperty } from '@nestjs/swagger';

export class WorkspaceMemberDto {
  @ApiProperty({ type: String, format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) displayName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) joinedAt!: string;
}
export class WorkspaceDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, maxLength: 120 }) name!: string;
  @ApiProperty({ type: String, format: 'uuid' }) ownerId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) styleRevision!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) archivedAt!: string | null;
  @ApiProperty({ type: [WorkspaceMemberDto], required: false }) members?: WorkspaceMemberDto[];
}
export class WorkspaceResultDto {
  @ApiProperty({ type: WorkspaceDto }) workspace!: WorkspaceDto;
}
export class WorkspacesPageDto {
  @ApiProperty({ type: [WorkspaceDto] }) workspaces!: WorkspaceDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}
export class WorkspaceInviteDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'email' }) email!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, description: 'Shown once for manual delivery; only its SHA-256 digest is stored' }) token!: string;
}
export class WorkspaceInviteResultDto {
  @ApiProperty({ type: WorkspaceInviteDto }) invite!: WorkspaceInviteDto;
}
export class WorkspaceStyleDto {
  @ApiProperty({ type: Number, minimum: 1 }) revision!: number;
  @ApiProperty({ type: String }) brandbook!: string;
  @ApiProperty({ type: String }) tone!: string;
  @ApiProperty({ type: Object }) settings!: Record<string, unknown>;
  @ApiProperty({ type: String, format: 'uuid' }) createdBy!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class WorkspaceStyleResultDto {
  @ApiProperty({ type: WorkspaceStyleDto }) style!: WorkspaceStyleDto;
}
