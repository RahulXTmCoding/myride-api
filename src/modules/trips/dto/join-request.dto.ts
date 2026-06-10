import { IsOptional, IsString, MaxLength } from 'class-validator';

export class JoinRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
