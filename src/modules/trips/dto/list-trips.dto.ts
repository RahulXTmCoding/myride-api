import { IsOptional, IsIn, IsInt, Min, Max, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export class ListTripsDto {
  @IsOptional()
  @IsIn(['mine', 'joined', 'all'])
  scope?: 'mine' | 'joined' | 'all';

  @IsOptional()
  @IsIn(['pending', 'in-progress', 'completed', 'cancelled'])
  status?: 'pending' | 'in-progress' | 'completed' | 'cancelled';

  @IsOptional()
  @IsIn(['public', 'private'])
  visibility?: 'public' | 'private';

  @IsOptional()
  @IsUUID()
  community_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
