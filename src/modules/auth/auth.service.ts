import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import { FirebaseService } from './firebase.service';

// In-memory OTP storage for development (replace with Redis in production)
const otpStore = new Map<string, { code: string; expiresAt: number }>();

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private firebaseService: FirebaseService,
  ) {}

  /**
   * Request OTP for phone number
   * - Development: Generate and log OTP
   * - Production: Use Firebase (sends SMS automatically)
   */
  async requestOtp(phone: string): Promise<{ message: string; expires_in: number; mode: string }> {
    // Validate phone number format
    if (!phone.match(/^\+?[1-9]\d{1,14}$/)) {
      throw new BadRequestException('Invalid phone number format (use E.164 format: +1234567890)');
    }

    const isFirebaseEnabled = this.firebaseService.isFirebaseEnabled();

    if (isFirebaseEnabled) {
      // Production mode: Firebase handles OTP sending
      this.logger.log(`📱 Firebase will send OTP to ${phone}`);

      return {
        message: `OTP will be sent to ${phone} via SMS`,
        expires_in: 300, // 5 minutes
        mode: 'firebase',
      };
    } else {
      // Development mode: Console-based OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

      // Store OTP in memory
      otpStore.set(phone, { code: otp, expiresAt });

      // Log OTP to console
      this.logger.log(`🔐 [DEV MODE] OTP for ${phone}: ${otp} (expires in 5 minutes)`);

      // Clean up expired OTPs
      this.cleanupExpiredOtps();

      return {
        message: `OTP generated (check server console)`,
        expires_in: 300,
        mode: 'development',
      };
    }
  }

  /**
   * Login with phone and OTP (development mode)
   * OR Login with Firebase ID token (production mode)
   */
  async login(phone: string, otp: string): Promise<{
    access_token: string;
    refresh_token: string;
    user: User;
  }> {
    const isFirebaseEnabled = this.firebaseService.isFirebaseEnabled();

    if (!isFirebaseEnabled) {
      // Development mode: Verify OTP from memory
      return this.loginWithDevOtp(phone, otp);
    } else {
      // Production mode: Should not be called (use loginWithFirebase instead)
      throw new BadRequestException('Use Firebase authentication in production mode');
    }
  }

  /**
   * Login with development OTP (console-based)
   */
  private async loginWithDevOtp(phone: string, otp: string): Promise<{
    access_token: string;
    refresh_token: string;
    user: User;
  }> {
    // Get stored OTP
    const storedOtp = otpStore.get(phone);

    if (!storedOtp) {
      throw new UnauthorizedException('No OTP request found. Please request OTP first.');
    }

    // Check if expired
    if (Date.now() > storedOtp.expiresAt) {
      otpStore.delete(phone);
      throw new UnauthorizedException('OTP expired. Please request a new one.');
    }

    // Verify OTP
    if (storedOtp.code !== otp) {
      throw new UnauthorizedException('Invalid OTP code');
    }

    // OTP verified, remove from store
    otpStore.delete(phone);

    // Find or create user
    let user = await this.userRepository.findOne({ where: { phone } });

    if (!user) {
      user = this.userRepository.create({
        phone,
        is_verified: true,
        is_active: true,
      });
      user = await this.userRepository.save(user);
      this.logger.log(`✅ New user registered: ${phone}`);
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Generate tokens
    const tokens = await this.generateTokens(user);

    // Save refresh token (hashed)
    user.refresh_token = await bcrypt.hash(tokens.refresh_token, 10);
    await this.userRepository.save(user);

    return { ...tokens, user };
  }

  /**
   * Login with Firebase ID token (production mode)
   */
  async loginWithFirebase(firebaseToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    user: User;
  }> {
    if (!this.firebaseService.isFirebaseEnabled()) {
      throw new BadRequestException('Firebase is not enabled. Use development OTP login.');
    }

    // Verify Firebase token
    const decodedToken = await this.firebaseService.verifyIdToken(firebaseToken);
    const phone = decodedToken.phone_number;

    if (!phone) {
      throw new UnauthorizedException('Phone number not found in Firebase token');
    }

    // Find or create user
    let user = await this.userRepository.findOne({ where: { phone } });

    if (!user) {
      user = this.userRepository.create({
        phone,
        is_verified: true,
        is_active: true,
      });
      user = await this.userRepository.save(user);
      this.logger.log(`✅ New user registered via Firebase: ${phone}`);
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Generate JWT tokens
    const tokens = await this.generateTokens(user);

    // Save refresh token
    user.refresh_token = await bcrypt.hash(tokens.refresh_token, 10);
    await this.userRepository.save(user);

    return { ...tokens, user };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<{
    access_token: string;
  }> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get('JWT_SECRET'),
      });

      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
      });

      if (!user || !user.refresh_token) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Verify refresh token matches stored hash
      const isValid = await bcrypt.compare(refreshToken, user.refresh_token);
      if (!isValid) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Generate new access token
      const accessToken = this.jwtService.sign(
        { sub: user.id, phone: user.phone },
        {
          expiresIn: this.configService.get('JWT_ACCESS_EXPIRATION'),
        },
      );

      return { access_token: accessToken };
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /**
   * Get current user from token
   */
  async getCurrentUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  /**
   * Logout user (invalidate refresh token)
   */
  async logout(userId: string): Promise<{ message: string }> {
    await this.userRepository.update(userId, { refresh_token: undefined });
    return { message: 'Logged out successfully' };
  }

  /**
   * Generate JWT tokens
   */
  private async generateTokens(user: User): Promise<{
    access_token: string;
    refresh_token: string;
  }> {
    const payload = { sub: user.id, phone: user.phone };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRATION'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRATION'),
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  /**
   * Validate user by ID (used by JWT strategy)
   */
  async validateUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user || !user.is_active) {
      throw new UnauthorizedException('User not found or inactive');
    }

    return user;
  }

  /**
   * Clean up expired OTPs from memory
   */
  private cleanupExpiredOtps() {
    const now = Date.now();
    for (const [phone, data] of otpStore.entries()) {
      if (now > data.expiresAt) {
        otpStore.delete(phone);
      }
    }
  }
}
