import {
  IsString,
  IsOptional,
  IsEnum,
  IsUrl,
  MinLength,
  MaxLength,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';

export class CreateCommunityDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsUrl({}, { message: 'avatar_url must be a valid URL' })
  @IsOptional()
  avatar_url?: string;

  @IsEnum(['invite_only', 'open'])
  @IsOptional()
  join_type?: 'invite_only' | 'open';
}

export class UpdateCommunityDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsUrl({}, { message: 'avatar_url must be a valid URL' })
  @IsOptional()
  avatar_url?: string;

  @IsEnum(['invite_only', 'open'])
  @IsOptional()
  join_type?: 'invite_only' | 'open';
}

export class InviteMembersDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  phones: string[];
}
