import { ApiProperty } from '@nestjs/swagger';
import { MaterialKind, MaterialPurpose, SourceOrigin } from '@contextflow/backend';

export class MaterialDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) projectId!: string;
  @ApiProperty({ enum: MaterialKind }) kind!: MaterialKind;
  @ApiProperty({ enum: MaterialPurpose }) purpose!: MaterialPurpose;
  @ApiProperty({ type: String, maxLength: 200 }) label!: string;
  @ApiProperty() included!: boolean;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) currentSnapshotId!: string | null;
  @ApiProperty({ type: String, format: 'uuid' }) createdBy!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

export class SourcesPageDto { @ApiProperty({ type: [MaterialDto] }) materials!: MaterialDto[]; }
export class MaterialResultDto { @ApiProperty({ type: MaterialDto }) material!: MaterialDto; }
export class FragmentDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ minimum: 1 }) ordinal!: number;
  @ApiProperty({ minimum: 0 }) startOffset!: number;
  @ApiProperty({ minimum: 0 }) endOffset!: number;
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' }) sha256!: string;
}
export class SnapshotSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ minimum: 1 }) sequence!: number;
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' }) sha256!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty({ enum: SourceOrigin }) origin!: SourceOrigin;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) originalAssetId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) previousSnapshotId!: string | null;
  @ApiProperty({ type: String, nullable: true }) originalFilename!: string | null;
  @ApiProperty({ type: String, format: 'uuid' }) createdBy!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class SourceSnapshotDto extends SnapshotSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' }) projectId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) materialId!: string;
  @ApiProperty({ type: String }) normalizedText!: string;
  @ApiProperty({ type: [FragmentDto] }) fragments!: FragmentDto[];
}
export class CreateSourceResultDto {
  @ApiProperty({ type: MaterialDto }) material!: MaterialDto;
  @ApiProperty({ type: SnapshotSummaryDto }) snapshot!: SnapshotSummaryDto;
}
export class SnapshotResultDto { @ApiProperty({ type: SourceSnapshotDto }) snapshot!: SourceSnapshotDto; }
export class MaterialDetailDto {
  @ApiProperty({ type: MaterialDto }) material!: MaterialDto;
  @ApiProperty({ type: [SnapshotSummaryDto] }) snapshots!: SnapshotSummaryDto[];
}
