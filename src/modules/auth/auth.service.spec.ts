import { Test } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
import { REDIS_CLIENT } from './redis.provider';
import { User } from '../users/entities/user.entity';

/**
 * Minimal in-memory Redis mock implementing the subset used by AuthService.
 */
class RedisMock {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  private now(): number {
    return Date.now();
  }

  private purge(key: string): void {
    const entry = this.store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.purge(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    _mode?: string,
    ttl?: number,
  ): Promise<'OK'> {
    const expiresAt = ttl ? this.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    this.purge(key);
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === undefined) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000));
  }

  async incr(key: string): Promise<number> {
    this.purge(key);
    const entry = this.store.get(key);
    const next = (entry ? parseInt(entry.value, 10) : 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt });
    return next;
  }

  async expire(key: string, ttl: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = this.now() + ttl * 1000;
    return 1;
  }
}

describe('AuthService', () => {
  let service: AuthService;
  let redis: RedisMock;

  const userRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    redis = new RedisMock();
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        {
          provide: JwtService,
          useValue: { sign: jest.fn(() => 'tok'), verify: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === 'NODE_ENV' ? 'test' : undefined,
            ),
          },
        },
        {
          provide: FirebaseService,
          useValue: { isFirebaseEnabled: () => false },
        },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('requestOtp', () => {
    it('rejects when cooldown is active', async () => {
      await service.requestOtp('+919876543210');

      await expect(service.requestOtp('+919876543210')).rejects.toMatchObject({
        getStatus: expect.any(Function),
      });

      try {
        await service.requestOtp('+919876543210');
      } catch (err) {
        const e = err as HttpException;
        expect(e.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        const resp = e.getResponse() as { error: string; retry_after: number };
        expect(resp.error).toBe('RESEND_TOO_SOON');
        expect(resp.retry_after).toBeGreaterThan(0);
        expect(resp.retry_after).toBeLessThanOrEqual(60);
      }
    });

    it('returns expires_in=300 and resend_after=60 on success', async () => {
      const res = await service.requestOtp('+919876543211');
      expect(res).toMatchObject({ success: true, expires_in: 300, resend_after: 60 });
      // dev_otp is present in non-production (NODE_ENV=test here)
      expect(typeof (res as any).dev_otp).toBe('string');
    });
  });

  describe('login lockout', () => {
    it('locks account for 15 minutes after 3 failed attempts', async () => {
      const phone = '+919876543299';
      await service.requestOtp(phone);

      // 1st wrong
      await expect(service.login(phone, '000000')).rejects.toMatchObject({});
      // 2nd wrong
      await expect(service.login(phone, '000000')).rejects.toMatchObject({});

      // 3rd wrong -> ACCOUNT_LOCKED
      try {
        await service.login(phone, '000000');
        fail('expected lockout');
      } catch (err) {
        const e = err as HttpException;
        expect(e.getStatus()).toBe(HttpStatus.LOCKED);
        const resp = e.getResponse() as { error: string; unlock_at: string };
        expect(resp.error).toBe('ACCOUNT_LOCKED');
        expect(typeof resp.unlock_at).toBe('string');
      }

      // Subsequent attempts also locked
      try {
        await service.login(phone, '000000');
        fail('expected lockout');
      } catch (err) {
        const e = err as HttpException;
        expect(e.getStatus()).toBe(HttpStatus.LOCKED);
      }
    });

    it('returns attempts_remaining on first wrong attempt', async () => {
      const phone = '+919876543277';
      await service.requestOtp(phone);
      try {
        await service.login(phone, '000000');
        fail('expected invalid');
      } catch (err) {
        const e = err as HttpException;
        expect(e.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        const resp = e.getResponse() as {
          error: string;
          attempts_remaining: number;
        };
        expect(resp.error).toBe('INVALID_OTP');
        expect(resp.attempts_remaining).toBe(2);
      }
    });

    it('returns OTP_EXPIRED when no OTP stored', async () => {
      try {
        await service.login('+919999999999', '123456');
        fail('expected expired');
      } catch (err) {
        const e = err as HttpException;
        expect(e.getStatus()).toBe(HttpStatus.GONE);
        expect((e.getResponse() as { error: string }).error).toBe(
          'OTP_EXPIRED',
        );
      }
    });
  });
});
