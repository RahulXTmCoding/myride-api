import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type Redis from 'ioredis';
import { AppModule } from './../src/app.module';
import { REDIS_CLIENT } from './../src/modules/auth/redis.provider';

/**
 * E2E coverage for PATCH /api/v1/auth/me — verifies that setting `name` for
 * the first time flips is_onboarding_complete to true.
 *
 * Requires postgres + redis to be reachable. If infra is unavailable, this
 * spec is skipped (see beforeAll bail-out).
 */
describe('Auth /me onboarding flip (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let available = true;

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      app.setGlobalPrefix('api/v1');
      await app.init();
      redis = app.get<Redis>(REDIS_CLIENT);
    } catch (err) {
      console.warn('[e2e] infra unavailable, skipping:', (err as Error).message);
      available = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('PATCH /auth/me flips is_onboarding_complete when name is set first time', async () => {
    if (!available) {
      return;
    }
    const phone = `+1${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/request-otp')
      .send({ phone })
      .expect(200);

    const otp = await redis.get(`otp:code:${phone}`);
    expect(otp).toMatch(/^\d{6}$/);

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phone, otp })
      .expect(200);

    expect(loginRes.body.user.is_onboarding_complete).toBe(false);
    expect(loginRes.body.user.name).toBeNull();
    const accessToken: string = loginRes.body.access_token;

    const meBefore = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(meBefore.body.is_onboarding_complete).toBe(false);

    const patchRes = await request(app.getHttpServer())
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Test Rider' })
      .expect(200);

    expect(patchRes.body.name).toBe('Test Rider');
    expect(patchRes.body.is_onboarding_complete).toBe(true);
  }, 30_000);
});
