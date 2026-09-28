import { ApiProperty } from '@nestjs/swagger';
import { ProjectFormat, AssetPurpose, AssetState } from '@contextflow/backend';

export class ProjectDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) workspaceId!: string;
  @ApiProperty({ type: String, maxLength: 500 }) topic!: string;
  @ApiProperty({ enum: ProjectFormat, isArray: true }) formats!: ProjectFormat[];
  @ApiProperty({ type: Number, minimum: 1 }) revision!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) archivedAt!: string | null;
}
export class ProjectResultDto {
  @ApiProperty({ type: ProjectDto }) project!: ProjectDto;
}
export class ProjectsPageDto {
  @ApiProperty({ type: [ProjectDto] }) projects!: ProjectDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}
export class AssetMetadataDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) projectId!: string;
  @ApiProperty({ type: String }) mediaType!: string;
  @ApiProperty({ type: Number, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) bytes!: number;
  @ApiProperty({ type: String, pattern: '^[a-f0-9]{64}$' }) sha256!: string;
  @ApiProperty({ enum: AssetState }) state!: AssetState;
  @ApiProperty({ enum: AssetPurpose }) purpose!: AssetPurpose;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class AssetMetadataResultDto {
  @ApiProperty({ type: AssetMetadataDto }) asset!: AssetMetadataDto;
}
