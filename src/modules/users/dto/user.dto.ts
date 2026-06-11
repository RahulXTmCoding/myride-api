import {
  IsString,
  IsOptional,
  IsUrl,
  MinLength,
  MaxLength,
  IsArray,
  ValidateNested,
  IsPhoneNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EmergencyContactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsString()
  @MinLength(7)
  @MaxLength(20)
  phone: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  relationship?: string;
}

export class UpdateProfileDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  bio?: string;

  @IsUrl({}, { message: 'avatar_url must be a valid URL' })
  @IsOptional()
  avatar_url?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => EmergencyContactDto)
  emergency_contacts?: EmergencyContactDto[];

  /** Expo / FCM push notification token */
  @IsString()
  @IsOptional()
  @MaxLength(512)
  push_token?: string;
}
