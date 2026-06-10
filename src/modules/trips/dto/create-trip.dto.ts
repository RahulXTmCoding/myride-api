import {
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  IsNumber,
  IsInt,
  Min,
  Max,
  IsArray,
  ValidateNested,
  IsISO8601,
  ArrayMinSize,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One stop in a trip. The first stop is implicitly the start, the last is the end.
 * stop_order is assigned server-side based on array position.
 */
export class CreateTripStopDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsString()
  @IsIn(['start', 'waypoint', 'fuel', 'food', 'rest', 'destination'])
  stop_type: 'start' | 'waypoint' | 'fuel' | 'food' | 'rest' | 'destination';

  @IsOptional()
  @IsInt()
  @Min(0)
  duration_minutes?: number;

  @IsOptional()
  @IsBoolean()
  is_mandatory?: boolean;
}

export class TripMetadataDto {
  @IsOptional()
  @IsIn(['bike', 'car', 'van', 'other'])
  vehicle_type?: 'bike' | 'car' | 'van' | 'other';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(['easy', 'moderate', 'hard'])
  difficulty_level?: 'easy' | 'moderate' | 'hard';
}

export class CreateTripDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsIn(['one-way', 'round-trip'])
  trip_type: 'one-way' | 'round-trip';

  @IsIn(['public', 'private'])
  visibility: 'public' | 'private';

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

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateTripStopDto)
  stops: CreateTripStopDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TripMetadataDto)
  metadata?: TripMetadataDto;
}
