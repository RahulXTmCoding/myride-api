import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import type Redis from 'ioredis';

import { SOSAlert } from './entities/sos-alert.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';
import { CreateSosDto } from './dto/create-sos.dto';
import { CHAT_REDIS } from '../chat/chat.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';

/**
 * SosService — FR-063..FR-075.
 *
 * Lifecycle:
 *   create()   — write alert with PostGIS POINT, publish "sos:new" pubsub
 *                payload so any connected client/gateway can fan it out.
 *   cancel()   — sender-only OR admin, within 30s window for self-cancel
 *                (FR-072). Beyond that, marks as resolved/false-alarm.
 *   listActive() — show active alerts for a trip; visible only to members.
 *
 * Pubsub channel: "sos:new" / "sos:update"
 *   { trip_id, sos_id, sender_id, status, location, message }
 * The chat gateway (or a future SOS gateway) can subscribe and push to
 * the trip's chat room participants. For v1 the frontend polls
 * GET /trips/:id/sos on a short interval since we don't have a dedicated
 * SOS WS gateway yet.
 */
@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);
  private static readonly SELF_CANCEL_WINDOW_MS = 30 * 1000;

  constructor(
    @InjectRepository(SOSAlert)
    private readonly sosRepo: Repository<SOSAlert>,
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripParticipant)
    private readonly participantRepo: Repository<TripParticipant>,
    private readonly dataSource: DataSource,
    @Inject(CHAT_REDIS) private readonly redis: Redis,
    private readonly notificationsService: NotificationsService,
    private readonly usersService: UsersService,
  ) {}

  async create(
    tripId: string,
    senderId: string,
    dto: CreateSosDto,
  ): Promise<SOSAlert> {
    await this.assertMember(tripId, senderId);

    // Insert with raw SQL for the geography point — TypeORM can't bind it directly.
    const inserted: Array<{ id: string; created_at: Date }> =
      await this.dataSource.query(
        `INSERT INTO sos_alerts
         (trip_id, sender_id, status, location, address, message, alert_type, acknowledged_by, created_at)
       VALUES
         ($1, $2, 'active',
          ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
          $5, $6, $7, '[]'::jsonb, NOW())
       RETURNING id, created_at`,
        [
          tripId,
          senderId,
          dto.location.longitude,
          dto.location.latitude,
          dto.address ?? null,
          dto.message ?? null,
          dto.alert_type ?? null,
        ],
      );

    const id: string = inserted[0].id;
    const alert = await this.sosRepo.findOne({
      where: { id },
      relations: ['sender'],
    });
    if (!alert) throw new NotFoundException({ error: 'SOS_NOT_FOUND' });

    // Best-effort pubsub fan-out
    await this.redis
      .publish(
        'sos:new',
        JSON.stringify({
          trip_id: tripId,
          sos_id: id,
          sender_id: senderId,
          sender_name: alert.sender?.name ?? null,
          status: 'active',
          location: {
            latitude: dto.location.latitude,
            longitude: dto.location.longitude,
          },
          message: dto.message ?? null,
          alert_type: dto.alert_type ?? null,
          created_at: alert.created_at,
        }),
      )
      .catch((e: Error) =>
        this.logger.warn(`sos:new publish failed: ${e?.message}`),
      );

    // Push notification to all trip participants (best-effort, fire-and-forget)
    this.participantRepo
      .find({ where: { trip_id: tripId, status: 'approved' } })
      .then(async (participants) => {
        const otherIds = participants
          .map((p) => p.user_id)
          .filter((id) => id !== senderId);
        if (otherIds.length === 0) return;

        const tokenMap = await this.usersService.findPushTokens(otherIds);
        const tokens = Array.from(tokenMap.values());
        if (tokens.length === 0) return;

        const trip = await this.tripRepo.findOne({ where: { id: tripId } });
        const senderName = alert.sender?.name ?? 'Someone';
        const typeLabel = dto.alert_type ?? 'emergency';

        await this.notificationsService.sendPushMany(tokens, {
          title: `🚨 SOS Alert — ${trip?.title ?? 'Trip'}`,
          body: `${senderName} triggered a ${typeLabel} alert. Open the app to help.`,
          data: { type: 'sos_alert', trip_id: tripId, sos_id: id },
        });
      })
      .catch((e: Error) =>
        this.logger.warn(`SOS push notification failed: ${e?.message}`),
      );

    return alert;
  }

  /**
   * Cancel an SOS.
   *  - Sender within 30s → 'false-alarm' (FR-072, FR-073).
   *  - Sender after 30s or admin any time → 'resolved'.
   */
  async cancel(sosId: string, userId: string): Promise<SOSAlert> {
    const alert = await this.sosRepo.findOne({ where: { id: sosId } });
    if (!alert) throw new NotFoundException({ error: 'SOS_NOT_FOUND' });
    if (alert.status !== 'active') return alert; // idempotent

    const trip = await this.tripRepo.findOne({ where: { id: alert.trip_id } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });

    const isSender = alert.sender_id === userId;
    const isAdmin = trip.creator_id === userId;
    if (!isSender && !isAdmin) {
      throw new ForbiddenException({ error: 'CANNOT_CANCEL_SOS' });
    }

    const ageMs = Date.now() - new Date(alert.created_at).getTime();
    const withinWindow = ageMs <= SosService.SELF_CANCEL_WINDOW_MS;
    alert.status = isSender && withinWindow ? 'false-alarm' : 'resolved';
    alert.resolved_at = new Date();
    const saved = await this.sosRepo.save(alert);

    await this.redis
      .publish(
        'sos:update',
        JSON.stringify({
          trip_id: alert.trip_id,
          sos_id: sosId,
          status: saved.status,
          resolved_at: saved.resolved_at,
        }),
      )
      .catch(() => {});

    return saved;
  }

  async listActive(tripId: string, userId: string): Promise<SOSAlert[]> {
    await this.assertMember(tripId, userId);
    return this.sosRepo.find({
      where: { trip_id: tripId, status: 'active' },
      relations: ['sender'],
      order: { created_at: 'DESC' },
    });
  }

  /** All-time history for the trip (admin or any member). */
  async listAll(tripId: string, userId: string): Promise<SOSAlert[]> {
    await this.assertMember(tripId, userId);
    return this.sosRepo.find({
      where: { trip_id: tripId },
      relations: ['sender'],
      order: { created_at: 'DESC' },
      take: 100,
    });
  }

  async acknowledge(sosId: string, userId: string): Promise<SOSAlert> {
    const alert = await this.sosRepo.findOne({ where: { id: sosId } });
    if (!alert) throw new NotFoundException({ error: 'SOS_NOT_FOUND' });
    await this.assertMember(alert.trip_id, userId);

    const already =
      Array.isArray(alert.acknowledged_by) &&
      alert.acknowledged_by.some((a) => a.user_id === userId);
    if (already) return alert;

    alert.acknowledged_by = [
      ...(alert.acknowledged_by ?? []),
      { user_id: userId, acknowledged_at: new Date().toISOString() },
    ];
    return this.sosRepo.save(alert);
  }

  private async assertMember(tripId: string, userId: string): Promise<void> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id === userId) return;
    const participant = await this.participantRepo.findOne({
      where: { trip_id: tripId, user_id: userId, status: 'approved' },
    });
    if (!participant) {
      throw new ForbiddenException({ error: 'NOT_TRIP_MEMBER' });
    }
  }
}
