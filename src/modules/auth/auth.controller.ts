import { Controller, Post, Body, Get, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RequestOtpDto, LoginDto, RefreshTokenDto } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { FirebaseService } from './firebase.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly firebaseService: FirebaseService,
  ) {}

  /**
   * POST /api/v1/auth/request-otp
   * Request OTP for phone number
   * - Development: Generates OTP and logs to console
   * - Production: Firebase sends SMS automatically
   */
  @Post('request-otp')
  @HttpCode(HttpStatus.OK)
  async requestOtp(@Body() requestOtpDto: RequestOtpDto) {
    return this.authService.requestOtp(requestOtpDto.phone);
  }

  /**
   * POST /api/v1/auth/login
   * Login with phone and OTP (development mode only)
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto.phone, loginDto.otp);
  }

  /**
   * POST /api/v1/auth/firebase-login
   * Login with Firebase ID token (production mode)
   */
  @Post('firebase-login')
  @HttpCode(HttpStatus.OK)
  async firebaseLogin(@Body() body: { firebase_token: string }) {
    return this.authService.loginWithFirebase(body.firebase_token);
  }

  /**
   * POST /api/v1/auth/refresh
   * Refresh access token using refresh token
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshToken(refreshTokenDto.refresh_token);
  }

  /**
   * GET /api/v1/auth/me
   * Get current user profile
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getCurrentUser(@CurrentUser() user: User) {
    return user;
  }

  /**
   * GET /api/v1/auth/mode
   * Get authentication mode (development or firebase)
   */
  @Get('mode')
  async getAuthMode() {
    const isFirebaseEnabled = this.firebaseService.isFirebaseEnabled();
    return {
      mode: isFirebaseEnabled ? 'firebase' : 'development',
      firebase_enabled: isFirebaseEnabled,
    };
  }

  /**
   * POST /api/v1/auth/logout
   * Logout current user (invalidate refresh token)
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: User) {
    return this.authService.logout(user.id);
  }
}
