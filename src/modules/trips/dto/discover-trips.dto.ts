import {
  IsOptional,
  IsIn,
  IsInt,
  Min,
  Max,
  IsNumber,
  IsISO8601,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for GET /trips/discover.
 *
 * All filters are optional. When `latitude` + `longitude` are both supplied,
 * results are ranked by start-stop proximity (PostGIS ST_Distance) and
 * `radius_km` (default 100km, cap 1000km) bounds the search via ST_DWithin.
 *
 * Date filtering: `from`/`to` are ISO timestamps applied to scheduled_start_time.
 */
export class DiscoverTripsDto {
  // ── Geo (optional, but lat+lon must be supplied together) ────────
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  @ValidateIf((o) => o.latitude !== undefined)
  longitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1000)
  radius_km?: number;

  // ── Date range ───────────────────────────────────────────────────
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  // ── Other filters ────────────────────────────────────────────────
  @IsOptional()
  @IsIn(['free', 'paid', 'all'])
  pricing?: 'free' | 'paid' | 'all';

  @IsOptional()
  @IsIn(['one-way', 'round-trip'])
  trip_type?: 'one-way' | 'round-trip';

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
