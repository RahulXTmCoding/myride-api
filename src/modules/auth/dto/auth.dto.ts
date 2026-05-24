import { IsString, IsNotEmpty, Matches, Length } from 'class-validator';

export class RequestOtpDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: 'Phone number must be in E.164 format (e.g., +1234567890)',
  })
  phone: string;
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?[1-9]\d{1,14}$/)
  phone: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'OTP must be 6 digits' })
  otp: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}
