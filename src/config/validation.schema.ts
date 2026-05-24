import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  // Database
  DATABASE_URL: Joi.string().required(),

  // Redis
  REDIS_URL: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('30d'),

  // Firebase (optional - enabled based on ENABLE_FIREBASE flag)
  ENABLE_FIREBASE: Joi.string().valid('true', 'false').default('false'),
  FIREBASE_SERVICE_ACCOUNT_PATH: Joi.string().optional(),

  // LiveKit
  LIVEKIT_API_KEY: Joi.string().required(),
  LIVEKIT_API_SECRET: Joi.string().required(),
  LIVEKIT_WS_URL: Joi.string().required(),

  // Twilio (optional for MVP)
  TWILIO_ACCOUNT_SID: Joi.string().optional(),
  TWILIO_AUTH_TOKEN: Joi.string().optional(),
  TWILIO_PHONE_NUMBER: Joi.string().optional(),

  // Google Maps (optional for MVP)
  GOOGLE_MAPS_API_KEY: Joi.string().optional(),

  // Stripe (optional for MVP)
  STRIPE_SECRET_KEY: Joi.string().optional(),
  STRIPE_WEBHOOK_SECRET: Joi.string().optional(),

  // Storage
  STORAGE_PROVIDER: Joi.string()
    .valid('local', 'azure', 'aws', 'gcp')
    .default('local'),

  // Frontend
  FRONTEND_URL: Joi.string().default('http://localhost:8081'),
});
