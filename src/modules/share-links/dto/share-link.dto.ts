import {
  IsOptional,
  IsString,
  IsIn,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

export class CreateShareLinkDto {
  @IsOptional()
  @IsIn(['view-only', 'auto-join', 'password-protected'])
  access_mode?: 'view-only' | 'auto-join' | 'password-protected';

  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 90) // up to 90 days
  expires_in_hours?: number;
}

export class UpdateShareLinkDto {
  @IsOptional()
  @IsIn(['view-only', 'auto-join', 'password-protected'])
  access_mode?: 'view-only' | 'auto-join' | 'password-protected';

  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 90)
  expires_in_hours?: number;
}

export class VerifyPasswordDto {
  @IsString()
  @MaxLength(128)
  password: string;
}

export class JoinViaLinkDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
