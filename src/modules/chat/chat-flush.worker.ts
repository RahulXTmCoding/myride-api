import { Injectable, OnApplicationBootstrap, OnApplicationShutdown, Logger } from '@nestjs/common';
import { ChatService } from './chat.service';

/**
 * ChatFlushWorker
 *
 * Drains the Redis write-ahead queue (chat:write_queue) into Postgres
 * in batches every 100ms.
 *
 * Why this exists:
 *   - handleSend pushes messages to Redis and broadcasts immediately.
 *     No socket waits for a Postgres INSERT — latency drops to ~1ms.
 *   - This worker runs in the background and does the actual DB writes
 *     in batches of up to 50 rows at a time (one INSERT per tick vs
 *     one INSERT per message).
 *   - If the queue backs up during a burst, the worker catches up
 *     automatically because each tick processes up to 50 items.
 *
 * Failure behaviour:
 *   - If Postgres is temporarily unavailable, messages stay in Redis.
 *   - On restart the worker resumes from wherever the queue left off.
 *   - Redis list is persistent (AOF/RDB) so messages survive a process crash.
 *   - The INSERT uses ON CONFLICT DO NOTHING so retries are safe (idempotent).
 *
 * Scaling note:
 *   - If running multiple NestJS instances, only one instance should run
 *     the flush worker, OR each instance runs it independently and the
 *     ON CONFLICT DO NOTHING prevents duplicate rows.
 *     LRANGE+LTRIM is not atomic across instances — for multi-instance
 *     deployments, replace with Redis BLPOP or a distributed lock.
 */
@Injectable()
export class ChatFlushWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatFlushWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** How often to flush (ms) */
  private readonly FLUSH_INTERVAL_MS = 100;

  /** Max messages per flush */
  private readonly BATCH_SIZE = 50;

  constructor(private readonly chatService: ChatService) {}

  onApplicationBootstrap() {
    this.start();
  }

  onApplicationShutdown() {
    this.stop();
  }

  private start() {
    this.logger.log(`[ChatFlushWorker] Starting — interval=${this.FLUSH_INTERVAL_MS}ms batch=${this.BATCH_SIZE}`);
    this.scheduleNext();
  }

  private stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.log('[ChatFlushWorker] Stopped');
  }

  private scheduleNext() {
    this.timer = setTimeout(() => this.tick(), this.FLUSH_INTERVAL_MS);
  }

  private async tick() {
    if (this.running) {
      // Previous tick still processing — skip and reschedule
      this.scheduleNext();
      return;
    }

    this.running = true;
    try {
      const flushed = await this.chatService.flushQueue(this.BATCH_SIZE);
      if (flushed > 0) {
        this.logger.debug(`[ChatFlushWorker] Flushed ${flushed} messages`);
      }
    } catch (err) {
      // Log but don't crash — messages remain in Redis queue for next tick
      this.logger.error('[ChatFlushWorker] Flush error', err);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }
}
