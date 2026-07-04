import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { User } from '../users/entities/user.entity';
import { FirebaseService } from './firebase.service';
import { REDIS_CLIENT } from './redis.provider';

const OTP_TTL_SECONDS = 300; // 5 minutes
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_OTP_ATTEMPTS = 3;
const LOCKOUT_SECONDS = 15 * 60; // 15 minutes

export interface PublicUser {
  id: string;
  phone: string;
  name: string | null;
  avatar_url: string | null;
  is_onboarding_complete: boolean;
  created_at: Date;
  vehicle?: unknown;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private firebaseService: FirebaseService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private otpKey(phone: string): string {
    return `otp:code:${phone}`;
  }
  private cooldownKey(phone: string): string {
    return `otp:cooldown:${phone}`;
  }
  private attemptsKey(phone: string): string {
    return `otp:attempts:${phone}`;
  }
  private lockKey(phone: string): string {
    return `otp:lock:${phone}`;
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      phone: user.phone,
      name: user.name ?? null,
      avatar_url: user.profile_photo_url ?? null,
      is_onboarding_complete: user.is_onboarding_complete ?? !!user.name,
      created_at: user.created_at,
    };
  }

  /**
   * Request OTP for phone number
   * - Dev: generate, store in Redis, log to console
   * - Firebase (prod): delegates to Firebase
   * Enforces 60s resend cooldown per phone.
   */
  async requestOtp(
    phone: string,
  ): Promise<{ success: true; expires_in: number; resend_after: number }> {
    if (!phone.match(/^\+?[1-9]\d{1,14}$/)) {
      throw new BadRequestException({
        error: 'INVALID_PHONE',
        message: 'Phone must be E.164',
      });
    }

    // Cooldown check
    const cooldownTtl = await this.redis.ttl(this.cooldownKey(phone));
    if (cooldownTtl > 0) {
      throw new HttpException(
        {
          error: 'RESEND_TOO_SOON',
          message: `Wait ${cooldownTtl} seconds before resending`,
          retry_after: cooldownTtl,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const isFirebaseEnabled = this.firebaseService.isFirebaseEnabled();
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';

    if (isFirebaseEnabled && isProd) {
      // Firebase sends the SMS. We still set cooldown.
      await this.redis.set(
        this.cooldownKey(phone),
        '1',
        'EX',
        RESEND_COOLDOWN_SECONDS,
      );
      this.logger.log(`Firebase will send OTP to ${phone}`);
      return {
        success: true,
        expires_in: OTP_TTL_SECONDS,
        resend_after: RESEND_COOLDOWN_SECONDS,
      };
    }

    // Dev mode: generate, store, log
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await this.redis.set(this.otpKey(phone), otp, 'EX', OTP_TTL_SECONDS);
    await this.redis.del(this.attemptsKey(phone));
    await this.redis.set(
      this.cooldownKey(phone),
      '1',
      'EX',
      RESEND_COOLDOWN_SECONDS,
    );

    this.logger.log(`[OTP] ${phone} -> ${otp}`);

    return {
      success: true,
      expires_in: OTP_TTL_SECONDS,
      resend_after: RESEND_COOLDOWN_SECONDS,
      // Dev-only convenience: OTP returned in response so callers don't need
      // server log access. NEVER included when NODE_ENV=production.
      ...(isProd ? {} : { dev_otp: otp }),
    };
  }

  /**
   * Login with phone and OTP
   */
  async login(
    phone: string,
    otp: string,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    user: PublicUser;
  }> {
    // Check lockout first
    const lockTtl = await this.redis.ttl(this.lockKey(phone));
    if (lockTtl > 0) {
      const unlockAt = new Date(Date.now() + lockTtl * 1000).toISOString();
      throw new HttpException(
        { error: 'ACCOUNT_LOCKED', unlock_at: unlockAt },
        HttpStatus.LOCKED,
      );
    }

    const stored = await this.redis.get(this.otpKey(phone));
    if (!stored) {
      throw new HttpException({ error: 'OTP_EXPIRED' }, HttpStatus.GONE);
    }

    if (stored !== otp) {
      // Increment attempts within the OTP window
      const attempts = await this.redis.incr(this.attemptsKey(phone));
      if (attempts === 1) {
        // Align attempts TTL with OTP window
        const otpTtl = await this.redis.ttl(this.otpKey(phone));
        if (otpTtl > 0) {
          await this.redis.expire(this.attemptsKey(phone), otpTtl);
        }
      }

      if (attempts >= MAX_OTP_ATTEMPTS) {
        await this.redis.set(this.lockKey(phone), '1', 'EX', LOCKOUT_SECONDS);
        await this.redis.del(this.otpKey(phone));
        await this.redis.del(this.attemptsKey(phone));
        const unlockAt = new Date(
          Date.now() + LOCKOUT_SECONDS * 1000,
        ).toISOString();
        throw new HttpException(
          { error: 'ACCOUNT_LOCKED', unlock_at: unlockAt },
          HttpStatus.LOCKED,
        );
      }

      const remaining = Math.max(0, MAX_OTP_ATTEMPTS - attempts);
      throw new HttpException(
        { error: 'INVALID_OTP', attempts_remaining: remaining },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Success — clear OTP/attempts
    await this.redis.del(this.otpKey(phone));
    await this.redis.del(this.attemptsKey(phone));

    let user = await this.userRepository.findOne({ where: { phone } });
    if (!user) {
      user = this.userRepository.create({
        phone,
        is_verified: true,
        is_active: true,
      });
      user = await this.userRepository.save(user);
      this.logger.log(`New user registered: ${phone}`);
    }

    if (!user.is_active) {
      throw new HttpException(
        { error: 'ACCOUNT_SUSPENDED' },
        HttpStatus.FORBIDDEN,
      );
    }

    const tokens = await this.generateTokens(user);
    user.refresh_token = await bcrypt.hash(tokens.refresh_token, 10);
    await this.userRepository.save(user);

    return { ...tokens, user: this.toPublicUser(user) };
  }

  async loginWithFirebase(firebaseToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    user: PublicUser;
  }> {
    if (!this.firebaseService.isFirebaseEnabled()) {
      throw new BadRequestException('Firebase is not enabled.');
    }

    const decodedToken =
      await this.firebaseService.verifyIdToken(firebaseToken);
    const phone = decodedToken.phone_number;
    if (!phone) {
      throw new UnauthorizedException(
        'Phone number not found in Firebase token',
      );
    }

    let user = await this.userRepository.findOne({ where: { phone } });
    if (!user) {
      user = this.userRepository.create({
        phone,
        is_verified: true,
        is_active: true,
      });
      user = await this.userRepository.save(user);
    }

    if (!user.is_active) {
      throw new HttpException(
        { error: 'ACCOUNT_SUSPENDED' },
        HttpStatus.FORBIDDEN,
      );
    }

    const tokens = await this.generateTokens(user);
    user.refresh_token = await bcrypt.hash(tokens.refresh_token, 10);
    await this.userRepository.save(user);

    return { ...tokens, user: this.toPublicUser(user) };
  }

  async refreshToken(
    refreshToken: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get('JWT_SECRET'),
      });

      const user = await this.userRepository
        .createQueryBuilder('user')
        .addSelect('user.refresh_token')
        .where('user.id = :id', { id: payload.sub })
        .getOne();

      if (!user || !user.refresh_token) {
        throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });
      }

      const isValid = await bcrypt.compare(refreshToken, user.refresh_token);
      if (!isValid) {
        throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });
      }

      const tokens = await this.generateTokens(user);
      user.refresh_token = await bcrypt.hash(tokens.refresh_token, 10);
      await this.userRepository.save(user);
      return tokens;
    } catch {
      throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });
    }
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return this.toPublicUser(user);
  }

  async updateProfile(
    userId: string,
    updates: { name?: string; avatar_url?: string; vehicle?: unknown },
  ): Promise<PublicUser & { vehicle?: unknown }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (updates.name !== undefined) {
      const trimmed = updates.name.trim();
      if (trimmed.length < 1 || trimmed.length > 100) {
        throw new BadRequestException({
          error: 'INVALID_NAME',
          message: 'Name must be 1-100 chars',
        });
      }
      user.name = trimmed;
      user.is_onboarding_complete = true;
    }

    if (updates.avatar_url !== undefined) {
      user.profile_photo_url = updates.avatar_url;
    }

    // Persist vehicle inside preferences jsonb (no schema change)
    let vehicle: unknown | undefined;
    if (updates.vehicle !== undefined) {
      const prefs = (user.preferences ?? {}) as Record<string, unknown>;
      prefs.vehicle = updates.vehicle;
      user.preferences = prefs;
      vehicle = updates.vehicle;
    } else if (
      user.preferences &&
      (user.preferences as Record<string, unknown>).vehicle
    ) {
      vehicle = (user.preferences as Record<string, unknown>).vehicle;
    }

    const saved = await this.userRepository.save(user);
    const publicUser = this.toPublicUser(saved);
    return { ...publicUser, vehicle };
  }

  async logout(userId: string): Promise<{ success: true }> {
    await this.userRepository.update(userId, { refresh_token: undefined });
    return { success: true };
  }

  private async generateTokens(
    user: User,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const payload = { sub: user.id, phone: user.phone };
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRATION') ?? '15m',
    });
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRATION') ?? '30d',
    });
    return { access_token: accessToken, refresh_token: refreshToken };
  }

  async validateUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('User not found or inactive');
    }
    return user;
  }
}
