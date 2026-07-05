import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: admin.app.App | null = null;
  private isEnabled: boolean;

  constructor(private configService: ConfigService) {
    // Enable Firebase only in production or if explicitly enabled
    this.isEnabled =
      this.configService.get('NODE_ENV') === 'production' ||
      this.configService.get('ENABLE_FIREBASE') === 'true';
  }

  onModuleInit() {
    if (!this.isEnabled) {
      this.logger.warn(
        '🔧 Firebase disabled - using console-based OTP (development mode)',
      );
      return;
    }

    try {
      // Resolve service account: prefer file path, fall back to base64 env var
      const serviceAccount = this.resolveServiceAccount();
      if (!serviceAccount) {
        this.logger.warn(
          '⚠️  No Firebase credentials found (set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON) - Firebase disabled',
        );
        this.isEnabled = false;
        return;
      }

      this.app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      });

      this.logger.log('✅ Firebase initialized successfully');
    } catch (error) {
      this.logger.error('❌ Firebase initialization failed:', error.message);
      this.logger.warn('Falling back to console-based OTP');
      this.isEnabled = false;
    }
  }

  /**
   * Resolve Firebase service account from one of two sources:
   * 1. FIREBASE_SERVICE_ACCOUNT_PATH — path to a JSON file on disk (local dev / mounted secret)
   * 2. FIREBASE_SERVICE_ACCOUNT_JSON — base64-encoded JSON string (Azure App Service env var)
   */
  private resolveServiceAccount(): object | null {
    // Option 1: file path (local dev, docker mount)
    const filePath = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');
    if (filePath) {
      try {
        if (fs.existsSync(filePath)) {
          return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        this.logger.warn(`⚠️  FIREBASE_SERVICE_ACCOUNT_PATH set but file not found at: ${filePath}`);
      } catch (e) {
        this.logger.warn(`⚠️  Could not read service account file: ${e.message}`);
      }
    }

    // Option 2: base64-encoded JSON in env var (Azure App Service / CI)
    const b64Json = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (b64Json) {
      try {
        const json = Buffer.from(b64Json, 'base64').toString('utf8');
        return JSON.parse(json);
      } catch (e) {
        this.logger.warn(`⚠️  Could not parse FIREBASE_SERVICE_ACCOUNT_JSON: ${e.message}`);
      }
    }

    return null;
  }

  /**
   * Check if Firebase is enabled
   */
  isFirebaseEnabled(): boolean {
    return this.isEnabled && this.app !== null;
  }

  /**
   * Verify Firebase ID token from frontend
   */
  async verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    if (!this.isFirebaseEnabled()) {
      throw new Error('Firebase is not enabled');
    }

    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      this.logger.log(
        `✅ Token verified for user: ${decodedToken.phone_number}`,
      );
      return decodedToken;
    } catch (error) {
      this.logger.error('❌ Token verification failed:', error.message);
      throw new Error('Invalid Firebase token');
    }
  }

  /**
   * Get user by phone number
   */
  async getUserByPhone(phone: string): Promise<admin.auth.UserRecord | null> {
    if (!this.isFirebaseEnabled()) {
      return null;
    }

    try {
      const user = await admin.auth().getUserByPhoneNumber(phone);
      return user;
    } catch (error) {
      return null;
    }
  }

  /**
   * Create custom token for user (optional - for advanced use cases)
   */
  async createCustomToken(uid: string): Promise<string> {
    if (!this.isFirebaseEnabled()) {
      throw new Error('Firebase is not enabled');
    }

    return admin.auth().createCustomToken(uid);
  }

  /**
   * Delete user from Firebase (for account deletion)
   */
  async deleteUser(uid: string): Promise<void> {
    if (!this.isFirebaseEnabled()) {
      return;
    }

    try {
      await admin.auth().deleteUser(uid);
      this.logger.log(`🗑️  Deleted Firebase user: ${uid}`);
    } catch (error) {
      this.logger.error(
        `Failed to delete Firebase user ${uid}:`,
        error.message,
      );
    }
  }
}
