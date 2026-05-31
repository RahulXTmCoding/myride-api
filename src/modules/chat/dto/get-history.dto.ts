import { IsIn, IsUUID, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class GetHistoryDto {
  @IsOptional()
  @IsUUID('4')
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}

export class RoomParamsDto {
  @IsIn(['trip', 'community'])
  room_type: 'trip' | 'community';

  @IsUUID('4')
  room_id: string;
}
