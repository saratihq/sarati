import { Allow, IsIn, IsOptional, IsString } from 'class-validator';

import type { MergeResolution, ResolutionChoice } from '../ir/merge';

const RESOLUTION_CHOICES: ResolutionChoice[] = ['source', 'target', 'custom', 'keep', 'delete'];

/** One operator decision from the in-app three-way resolver, matched to a conflict by (node_id, field_path). */
export class MergeResolutionDto implements MergeResolution {
  @IsString()
  node_id!: string;

  // null for edit_delete; the field path string for field conflicts.
  @IsOptional()
  @IsString()
  field_path: string | null = null;

  @IsIn(RESOLUTION_CHOICES)
  choice!: ResolutionChoice;

  // Arbitrary field value for the `custom` choice — @Allow so whitelist keeps it.
  @IsOptional()
  @Allow()
  value?: unknown;
}
