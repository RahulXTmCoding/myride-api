import {
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  IsNumber,
  IsInt,
  Min,
  Max,
  ValidateNested,
  IsISO8601,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TripMetadataDto } from './create-trip.dto';

/**
 * Update is identical to create minus stops. All fields optional.
 * Hand-rolled (no @nestjs/mapped-types dep) so we keep zero new deps.
 */
export class UpdateTripDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsIn(['one-way', 'round-trip'])
  trip_type?: 'one-way' | 'round-trip';

  @IsOptional()
  @IsIn(['public', 'private'])
  visibility?: 'public' | 'private';

  @IsOptional()
  @IsBoolean()
  is_paid?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  trip_price?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(20)
  max_participants?: number;

  @IsOptional()
  @IsISO8601()
  scheduled_start_time?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TripMetadataDto)
  metadata?: TripMetadataDto;
}
