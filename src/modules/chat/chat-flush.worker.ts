import { Injectable, OnApplicationBootstrap, OnApplicationShutdown, Logger, Inject } from '@nestjs/common';
import { ChatService, CHAT_REDIS, chatStreamKey, CHAT_STREAM_GROUP } from './chat.service';
import Redis from 'ioredis';

/**
 * ChatFlushWorker
 *
 * Drains per-room Redis Streams into Postgres in batches every 100ms.
 *
 * ## Design (FIX #5 — Redis Streams replaces Redis List)
 *
 * Old design (LRANGE + LTRIM) problems:
 *   - Not atomic: two instances would both read the same entries, and the
 *     second LTRIM could remove entries the first instance never processed.
 *   - No crash recovery: if the worker crashed between LRANGE and LTRIM,
 *     entries stayed in the list but were still at risk of being trimmed later.
 *
 * New design (XREADGROUP + XACK):
 *   - Consumer group: each entry is assigned to exactly one worker instance.
 *   - PEL (Pending Entries List): entries stay in PEL until XACK'd.
 *   - Crash recovery: on restart, xpending + xclaim re-delivers unacked entries.
 *   - Per-room streams: chat:stream:trip:<id>, chat:stream:community:<id>
 *     eliminates the global hot key from the old single-list design.
 *
 * ## Worker discovery
 *
 * Active streams are tracked in a Redis Set (`chat:active_streams`) by the
 * gateway when a user joins a room. The worker reads this set each tick to
 * know which streams to drain.
 *
 * ## Failure behaviour
 *
 * - Postgres unavailable → INSERT fails → XACK not called → entries stay in
 *   PEL → reclaimed and retried on next tick. Messages survive.
 * - Redis unavailable → worker logs error + reschedules. No crash.
 * - Queue depth > 5000 → error log emitted (ChatService handles this check).
 */
@Injectable()
export class ChatFlushWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatFlushWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId = `worker-${process.pid}-${Date.now()}`;

  private readonly FLUSH_INTERVAL_MS = 100;
  private readonly BATCH_SIZE = 50;

  /** Redis Set key tracking all streams that have had at least one message */
  static readonly ACTIVE_STREAMS_KEY = 'chat:active_streams';

  constructor(
    private readonly chatService: ChatService,
    @Inject(CHAT_REDIS) private readonly redis: Redis,
  ) {}

  onApplicationBootstrap() {
    this.logger.log(`[ChatFlushWorker] Starting workerId=${this.workerId} interval=${this.FLUSH_INTERVAL_MS}ms`);
    this.scheduleNext();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.log('[ChatFlushWorker] Stopped');
  }

  /**
   * Register a stream as active so the worker discovers and drains it.
   * Called by the gateway when a room's first message is sent.
   */
  async registerStream(roomType: string, roomId: string): Promise<void> {
    const key = chatStreamKey(roomType, roomId);
    await this.redis.sadd(ChatFlushWorker.ACTIVE_STREAMS_KEY, key);
    await this.chatService.ensureConsumerGroup(key);
  }

  private scheduleNext() {
    this.timer = setTimeout(() => this.tick(), this.FLUSH_INTERVAL_MS);
  }

  private async tick() {
    if (this.running) {
      this.scheduleNext();
      return;
    }

    this.running = true;
    try {
      await this.drainAllStreams();
    } catch (err) {
      this.logger.error('[ChatFlushWorker] Tick error', err);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private async drainAllStreams() {
    // Get all known active streams
    const streamKeys = await this.redis.smembers(ChatFlushWorker.ACTIVE_STREAMS_KEY);
    if (streamKeys.length === 0) return;

    // Drain each stream — in parallel for speed, bounded per-stream
    await Promise.all(
      streamKeys.map((key) =>
        this.chatService
          .flushStream(key, this.workerId, this.BATCH_SIZE)
          .catch((err) =>
            this.logger.error(`[ChatFlushWorker] Failed to flush ${key}`, err),
          ),
      ),
    );
  }
}
