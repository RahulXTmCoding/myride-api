import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * NotificationsService — sends FCM push notifications via Firebase Admin SDK.
 *
 * In development (ENABLE_FIREBASE=false) we log the notification to console
 * instead of actually sending, so the rest of the app doesn't break.
 *
 * Expo push tokens (starting with "ExponentPushToken[...]") are NOT FCM tokens.
 * We send them via the Expo Push API endpoint instead of FCM directly.
 * Both paths are handled here.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /** Send a push notification to a single token. Swallows errors so a bad token
   *  never propagates up to the business logic. */
  async sendPush(token: string | null | undefined, payload: PushPayload): Promise<void> {
    if (!token) return;

    // Expo push token → use Expo's HTTP v2 push endpoint
    if (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) {
      await this.sendExpo(token, payload);
      return;
    }

    // FCM token — requires Firebase App to be initialized
    await this.sendFcm(token, payload);
  }

  /** Send to multiple tokens in parallel (fire-and-forget per token). */
  async sendPushMany(tokens: string[], payload: PushPayload): Promise<void> {
    await Promise.all(tokens.map((t) => this.sendPush(t, payload)));
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async sendFcm(token: string, payload: PushPayload): Promise<void> {
    try {
      // Check if Firebase app is initialized
      const apps = admin.apps;
      if (!apps || apps.length === 0) {
        this.logger.debug(
          `[FCM-DEV] Would send to ${token.slice(0, 20)}…: "${payload.title}" — ${payload.body}`,
        );
        return;
      }

      const message: admin.messaging.Message = {
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      };

      const result = await admin.messaging().send(message);
      this.logger.debug(`[FCM] Sent: ${result}`);
    } catch (err: any) {
      // Invalid / unregistered tokens throw here — log and swallow
      this.logger.warn(`[FCM] Send failed (${token.slice(0, 20)}…): ${err.message}`);
    }
  }

  private async sendExpo(token: string, payload: PushPayload): Promise<void> {
    try {
      const body = JSON.stringify({
        to: token,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        sound: 'default',
        priority: 'high',
      });

      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      });

      const json: any = await res.json();
      if (json?.data?.status === 'error') {
        this.logger.warn(`[Expo Push] Error: ${JSON.stringify(json.data)}`);
      } else {
        this.logger.debug(`[Expo Push] Sent to ${token.slice(0, 30)}…`);
      }
    } catch (err: any) {
      this.logger.warn(`[Expo Push] Send failed: ${err.message}`);
    }
  }
}
