import {
  IsIn,
  IsUUID,
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class SendMessageDto {
  @IsIn(['trip', 'community'])
  room_type: 'trip' | 'community';

  @IsUUID('4')
  room_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  content: string;

  @IsOptional()
  @IsUUID('4')
  reply_to_id?: string;
}
