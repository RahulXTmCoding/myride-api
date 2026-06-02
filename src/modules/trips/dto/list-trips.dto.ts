import { IsOptional, IsIn, IsInt, Min, Max } from 'class-validator';
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
