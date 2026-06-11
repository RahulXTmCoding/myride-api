import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';

import { Trip } from './entities/trip.entity';
import { TripStop } from './entities/trip-stop.entity';
import { TripParticipant } from './entities/trip-participant.entity';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { ListTripsDto } from './dto/list-trips.dto';
import { DiscoverTripsDto } from './dto/discover-trips.dto';
import { ChatService, CHAT_REDIS } from '../chat/chat.service';
import { StopProgressService } from './stop-progress.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import type Redis from 'ioredis';

/**
 * TripsService — Trip CRUD + listing.
 *
 * Design choices:
 * - Trip + Stops + Creator-as-admin-Participant are written in a single DB transaction so
 *   we never end up with a half-created trip.
 * - PostGIS POINT geometry is built with raw SQL fragments (ST_SetSRID(ST_MakePoint(lng,lat),4326))
 *   because TypeORM's geography column expects WKT/EWKT strings on save.
 * - Listing always uses query-builder pagination (no offset surprises with eager joins).
 * - Editing window: spec FR-010 says admin can edit up to 6h before departure. Enforced here.
 */
@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);
  private static readonly EDIT_WINDOW_MS = 6 * 60 * 60 * 1000;

  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripStop)
    private readonly stopRepo: Repository<TripStop>,
    @InjectRepository(TripParticipant)
    private readonly participantRepo: Repository<TripParticipant>,
    private readonly dataSource: DataSource,
    private readonly chatService: ChatService,
    @Inject(CHAT_REDIS) private readonly chatRedis: Redis,
    private readonly stopProgressService: StopProgressService,
    private readonly notificationsService: NotificationsService,
    private readonly usersService: UsersService,
  ) {}

  async create(creatorId: string, dto: CreateTripDto): Promise<Trip> {
    // Validate departure is in future (FR edge case)
    if (dto.scheduled_start_time) {
      const start = new Date(dto.scheduled_start_time);
      if (start.getTime() < Date.now()) {
        throw new BadRequestException({
          error: 'INVALID_DEPARTURE_TIME',
          message: 'scheduled_start_time must be in the future',
        });
      }
    }

    // Paid trip with 0 amount → treat as free (spec edge case)
    const isPaid = !!dto.is_paid && (dto.trip_price ?? 0) > 0;
    const price = isPaid ? dto.trip_price! : null;

    // For round trips, last stop should mirror first; we don't enforce coords match, but
    // we do require >=2 stops (DTO already validates ArrayMinSize(2)).
    if (dto.trip_type === 'round-trip' && dto.stops.length < 2) {
      throw new BadRequestException({
        error: 'INVALID_ROUTE',
        message: 'Round trip needs at least 2 stops',
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const trip = manager.create(Trip, {
        title: dto.title,
        description: dto.description ?? null,
        trip_type: dto.trip_type,
        visibility: dto.visibility,
        is_paid: isPaid,
        trip_price: price as unknown as number, // typeorm decimal column accepts null at runtime
        status: 'pending',
        creator_id: creatorId,
        max_participants: dto.max_participants ?? 20,
        current_participants: 1, // creator counts
        scheduled_start_time: dto.scheduled_start_time
          ? new Date(dto.scheduled_start_time)
          : null,
        metadata: dto.metadata ?? null,
        community_id: dto.community_id ?? null,
      } as Partial<Trip>);

      const savedTrip = await manager.save(Trip, trip);

      // Persist stops. Use raw SQL for PostGIS POINT.
      for (let i = 0; i < dto.stops.length; i++) {
        const s = dto.stops[i];
        await manager.query(
          `INSERT INTO trip_stops
            (trip_id, stop_order, name, description, location, address, stop_type, duration_minutes, is_mandatory, created_at, updated_at)
           VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8, $9, $10, NOW(), NOW())`,
          [
            savedTrip.id,
            i + 1,
            s.name,
            s.description ?? null,
            s.longitude,
            s.latitude,
            s.address ?? null,
            s.stop_type,
            s.duration_minutes ?? null,
            s.is_mandatory ?? false,
          ],
        );
      }

      // Creator becomes admin participant
      const adminParticipant = manager.create(TripParticipant, {
        trip_id: savedTrip.id,
        user_id: creatorId,
        status: 'approved',
        role: 'admin',
        joined_at: new Date(),
        payment_status: isPaid ? 'paid' : null, // creator skips payment
      } as Partial<TripParticipant>);
      await manager.save(TripParticipant, adminParticipant);

      return this.loadFullTrip(savedTrip.id, manager.getRepository(Trip));
    });
  }

  async findOne(tripId: string, userId: string): Promise<Trip> {
    const trip = await this.loadFullTrip(tripId);
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });

    // Private trips: only creator + approved participants can read details
    if (trip.visibility === 'private') {
      const allowed =
        trip.creator_id === userId ||
        (await this.participantRepo.exist({
          where: {
            trip_id: tripId,
            user_id: userId,
            status: In(['approved', 'pending']),
          },
        }));
      if (!allowed) {
        throw new ForbiddenException({ error: 'TRIP_PRIVATE' });
      }
    }

    return trip;
  }

  async list(
    userId: string,
    dto: ListTripsDto,
  ): Promise<{ items: Trip[]; total: number }> {
    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;
    const scope = dto.scope ?? 'mine';

    const qb = this.tripRepo
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.creator', 'creator')
      .orderBy('trip.created_at', 'DESC')
      .limit(limit)
      .offset(offset);

    if (scope === 'mine') {
      qb.andWhere('trip.creator_id = :userId', { userId });
    } else if (scope === 'joined') {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM trip_participants tp
          WHERE tp.trip_id = trip.id AND tp.user_id = :userId AND tp.status = 'approved'
        )`,
        { userId },
      );
    } else {
      // 'all' → public discovery + own trips
      qb.andWhere(
        `(trip.visibility = 'public' OR trip.creator_id = :userId OR EXISTS (
          SELECT 1 FROM trip_participants tp
          WHERE tp.trip_id = trip.id AND tp.user_id = :userId AND tp.status = 'approved'
        ))`,
        { userId },
      );
    }

    if (dto.status)
      qb.andWhere('trip.status = :status', { status: dto.status });
    if (dto.visibility)
      qb.andWhere('trip.visibility = :visibility', {
        visibility: dto.visibility,
      });
    if (dto.community_id)
      qb.andWhere('trip.community_id = :communityId', { communityId: dto.community_id });

    const [items, total] = await qb.getManyAndCount();

    // Attach stops in a single batched query (avoid N+1)
    if (items.length > 0) {
      const stops = await this.stopRepo
        .createQueryBuilder('stop')
        .where('stop.trip_id IN (:...ids)', { ids: items.map((t) => t.id) })
        .orderBy('stop.trip_id')
        .addOrderBy('stop.stop_order', 'ASC')
        .getMany();
      const byTrip = new Map<string, TripStop[]>();
      for (const s of stops) {
        const list = byTrip.get(s.trip_id) ?? [];
        list.push(s);
        byTrip.set(s.trip_id, list);
      }
      for (const t of items) {
        (t as Trip & { stops: TripStop[] }).stops = byTrip.get(t.id) ?? [];
      }
    }

    return { items, total };
  }

  /**
   * Public discovery feed (FR-011..FR-013).
   *
   * Returns public, pending, not-full trips the caller hasn't already created
   * or joined. Supports optional filters:
   *   - geo: lat/lon + radius_km → ST_DWithin against start stop (stop_order=1)
   *   - date: from / to → scheduled_start_time bounds
   *   - pricing: 'free' | 'paid' | 'all'
   *   - trip_type: 'one-way' | 'round-trip'
   *
   * Sort:
   *   - if lat/lon supplied → distance ASC then departure ASC
   *   - otherwise          → departure ASC (NULLS LAST), created_at DESC
   *
   * The query joins on `trip_stops` only when geo filtering is active, to keep
   * non-geo discovery cheap (the planner can use trip indexes alone).
   */
  async discover(
    userId: string,
    dto: DiscoverTripsDto,
  ): Promise<{ items: Trip[]; total: number }> {
    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;
    const useGeo = dto.latitude !== undefined && dto.longitude !== undefined;
    const radiusMeters = (dto.radius_km ?? 100) * 1000;

    const qb = this.tripRepo
      .createQueryBuilder('trip')
      .leftJoinAndSelect('trip.creator', 'creator')
      .where('trip.visibility = :v', { v: 'public' })
      .andWhere('trip.status = :s', { s: 'pending' })
      .andWhere('trip.current_participants < trip.max_participants')
      .andWhere('trip.creator_id <> :userId', { userId })
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM trip_participants tp
          WHERE tp.trip_id = trip.id
            AND tp.user_id = :userId
            AND tp.status IN ('pending', 'approved')
        )`,
        { userId },
      )
      .limit(limit)
      .offset(offset);

    if (dto.trip_type) {
      qb.andWhere('trip.trip_type = :tt', { tt: dto.trip_type });
    }
    if (dto.pricing === 'free') {
      qb.andWhere('trip.is_paid = false');
    } else if (dto.pricing === 'paid') {
      qb.andWhere('trip.is_paid = true');
    }
    if (dto.from) {
      qb.andWhere('trip.scheduled_start_time >= :from', { from: dto.from });
    }
    if (dto.to) {
      qb.andWhere('trip.scheduled_start_time <= :to', { to: dto.to });
    }

    if (useGeo) {
      qb.innerJoin(
        'trip_stops',
        'start_stop',
        'start_stop.trip_id = trip.id AND start_stop.stop_order = 1',
      )
        .andWhere(
          `ST_DWithin(
             start_stop.location,
             ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
             :radius
           )`,
          { lng: dto.longitude, lat: dto.latitude, radius: radiusMeters },
        )
        .addSelect(
          `ST_Distance(
             start_stop.location,
             ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
           )`,
          'distance_m',
        )
        .orderBy('distance_m', 'ASC')
        .addOrderBy('trip.scheduled_start_time', 'ASC');
    } else {
      qb.orderBy('trip.scheduled_start_time', 'ASC', 'NULLS LAST').addOrderBy(
        'trip.created_at',
        'DESC',
      );
    }

    const [items, total] = await qb.getManyAndCount();

    // Attach stops in batch (mirrors list())
    if (items.length > 0) {
      const stops = await this.stopRepo
        .createQueryBuilder('stop')
        .where('stop.trip_id IN (:...ids)', { ids: items.map((t) => t.id) })
        .orderBy('stop.trip_id')
        .addOrderBy('stop.stop_order', 'ASC')
        .getMany();
      const byTrip = new Map<string, TripStop[]>();
      for (const s of stops) {
        const list = byTrip.get(s.trip_id) ?? [];
        list.push(s);
        byTrip.set(s.trip_id, list);
      }
      for (const t of items) {
        (t as Trip & { stops: TripStop[] }).stops = byTrip.get(t.id) ?? [];
      }
    }

    return { items, total };
  }

  async update(
    tripId: string,
    userId: string,
    dto: UpdateTripDto,
  ): Promise<Trip> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_TRIP_ADMIN' });
    }

    // FR-010: only editable up to 6h before departure
    if (
      trip.scheduled_start_time &&
      trip.scheduled_start_time.getTime() - Date.now() <
        TripsService.EDIT_WINDOW_MS &&
      trip.status === 'pending'
    ) {
      throw new BadRequestException({
        error: 'EDIT_WINDOW_CLOSED',
        message: 'Trip can only be edited up to 6 hours before departure',
      });
    }
    if (trip.status !== 'pending') {
      throw new BadRequestException({
        error: 'TRIP_NOT_EDITABLE',
        message: `Cannot edit a trip in '${trip.status}' state`,
      });
    }

    Object.assign(trip, {
      title: dto.title ?? trip.title,
      description: dto.description ?? trip.description,
      trip_type: dto.trip_type ?? trip.trip_type,
      visibility: dto.visibility ?? trip.visibility,
      is_paid: dto.is_paid ?? trip.is_paid,
      trip_price: dto.trip_price ?? trip.trip_price,
      max_participants: dto.max_participants ?? trip.max_participants,
      scheduled_start_time: dto.scheduled_start_time
        ? new Date(dto.scheduled_start_time)
        : trip.scheduled_start_time,
      metadata: dto.metadata ?? trip.metadata,
    });
    await this.tripRepo.save(trip);
    return this.loadFullTrip(tripId);
  }

  async cancel(tripId: string, userId: string): Promise<{ success: true }> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_TRIP_ADMIN' });
    }
    if (trip.status === 'completed') {
      throw new BadRequestException({ error: 'ALREADY_COMPLETED' });
    }
    trip.status = 'cancelled';
    await this.tripRepo.save(trip);
    return { success: true };
  }

  // ── Join requests / membership ─────────────────────────────────────────────

  /**
   * Submit a join request. Creates a `pending` participant row.
   * Spec: FR-014–020. Edge cases enforced:
   *  - already a member (any non-rejected status) → 409
   *  - trip full (current_participants >= max) → 409
   *  - trip not pending (started/cancelled/completed) → 400
   *  - creator trying to "join" their own trip → 400
   *  - private trip: only allowed via shareable link in v1 (rejected here unless invited;
   *    invite system isn't in this branch yet, so we allow private joins to keep dev unblocked
   *    but log a warning. Lock down once shareable-link auth lands.)
   */
  async requestJoin(
    tripId: string,
    userId: string,
    message?: string,
  ): Promise<TripParticipant> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id === userId) {
      throw new BadRequestException({ error: 'CREATOR_CANNOT_REQUEST' });
    }
    if (trip.status !== 'pending') {
      throw new BadRequestException({
        error: 'TRIP_NOT_JOINABLE',
        message: `Trip is ${trip.status}`,
      });
    }
    if (trip.current_participants >= trip.max_participants) {
      throw new ConflictException({ error: 'TRIP_FULL' });
    }
    if (trip.visibility === 'private') {
      this.logger.warn(
        `Private trip ${tripId} accepting direct join from ${userId} ` +
          `(shareable-link auth not implemented yet)`,
      );
    }

    const existing = await this.participantRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (
      existing &&
      existing.status !== 'rejected' &&
      existing.status !== 'left'
    ) {
      throw new ConflictException({
        error: 'ALREADY_REQUESTED',
        status: existing.status,
      });
    }

    if (existing) {
      // Re-request after rejection / leave: reset row to pending
      existing.status = 'pending';
      existing.joined_at = null as unknown as Date;
      existing.left_at = null as unknown as Date;
      return this.participantRepo.save(existing);
    }

    const participant = this.participantRepo.create({
      trip_id: tripId,
      user_id: userId,
      status: 'pending',
      role: 'member',
      payment_status: trip.is_paid ? 'pending' : null,
    } as Partial<TripParticipant>);
    // message is stored ephemerally — entity has no field for it yet, surface in admin list later
    if (message)
      this.logger.log(`Join request msg [${tripId}/${userId}]: ${message}`);
    return this.participantRepo.save(participant);
  }

  /**
   * Admin lists pending join requests.
   */
  async listJoinRequests(
    tripId: string,
    adminId: string,
  ): Promise<TripParticipant[]> {
    await this.assertAdmin(tripId, adminId);
    return this.participantRepo.find({
      where: { trip_id: tripId, status: 'pending' },
      order: { created_at: 'ASC' },
      relations: ['user'],
    });
  }

  /**
   * Admin approves a pending request. Increments current_participants, sets joined_at,
   * and invalidates the chat access cache + publishes nothing (chat re-checks on next event).
   */
  async approveJoin(
    tripId: string,
    adminId: string,
    userId: string,
  ): Promise<TripParticipant> {
    return this.dataSource.transaction(async (manager) => {
      const trip = await manager.findOne(Trip, { where: { id: tripId } });
      if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
      if (trip.creator_id !== adminId) {
        throw new ForbiddenException({ error: 'NOT_TRIP_ADMIN' });
      }
      const participant = await manager.findOne(TripParticipant, {
        where: { trip_id: tripId, user_id: userId },
      });
      if (!participant)
        throw new NotFoundException({ error: 'REQUEST_NOT_FOUND' });
      if (participant.status === 'approved') return participant; // idempotent
      if (participant.status !== 'pending') {
        throw new BadRequestException({
          error: 'REQUEST_NOT_PENDING',
          status: participant.status,
        });
      }
      if (trip.current_participants >= trip.max_participants) {
        throw new ConflictException({ error: 'TRIP_FULL' });
      }

      participant.status = 'approved';
      participant.joined_at = new Date();
      await manager.save(TripParticipant, participant);

      trip.current_participants = trip.current_participants + 1;
      await manager.save(Trip, trip);

      // Outside-tx ops (cache + pub/sub) — these are best-effort.
      await this.chatService
        .invalidateRoomAccessCache(userId, 'trip', tripId)
        .catch((e) => {
          this.logger.warn(`Failed to invalidate chat cache: ${e?.message}`);
        });
      // Seed stop progress rows so the UI has a complete dataset to render.
      await this.stopProgressService
        .ensureRowsExist(tripId, userId)
        .catch((e) => {
          this.logger.warn(`Failed to seed stop progress: ${e?.message}`);
        });

      // Push notification — fire-and-forget
      this.usersService.findPushToken(userId).then((token) => {
        if (token) {
          this.notificationsService.sendPush(token, {
            title: '🎉 Join request approved!',
            body: `You've been approved to join "${trip.title}". Check it out!`,
            data: { type: 'trip_approved', trip_id: tripId },
          }).catch(() => undefined);
        }
      }).catch(() => undefined);

      return participant;
    });
  }

  async rejectJoin(
    tripId: string,
    adminId: string,
    userId: string,
  ): Promise<TripParticipant> {
    await this.assertAdmin(tripId, adminId);
    const participant = await this.participantRepo.findOne({
      where: { trip_id: tripId, user_id: userId },
    });
    if (!participant)
      throw new NotFoundException({ error: 'REQUEST_NOT_FOUND' });
    if (participant.status === 'rejected') return participant;
    if (participant.status !== 'pending') {
      throw new BadRequestException({
        error: 'REQUEST_NOT_PENDING',
        status: participant.status,
      });
    }
    participant.status = 'rejected';
    return this.participantRepo.save(participant);
  }

  /**
   * Member leaves a trip. Decrements current_participants if they were approved.
   * Kicks them out of the chat room (chat access cache invalidation + Redis pub/sub
   * 'chat:kick' so the gateway disconnects any open sockets).
   */
  async leaveTrip(tripId: string, userId: string): Promise<{ success: true }> {
    return this.dataSource.transaction(async (manager) => {
      const trip = await manager.findOne(Trip, { where: { id: tripId } });
      if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
      if (trip.creator_id === userId) {
        throw new BadRequestException({
          error: 'CREATOR_CANNOT_LEAVE',
          message: 'Cancel the trip instead.',
        });
      }
      const participant = await manager.findOne(TripParticipant, {
        where: { trip_id: tripId, user_id: userId },
      });
      if (!participant || participant.status === 'left') {
        throw new NotFoundException({ error: 'NOT_A_MEMBER' });
      }

      const wasApproved = participant.status === 'approved';
      participant.status = 'left';
      participant.left_at = new Date();
      await manager.save(TripParticipant, participant);

      if (wasApproved) {
        trip.current_participants = Math.max(0, trip.current_participants - 1);
        await manager.save(Trip, trip);
      }

      // Best-effort chat eviction
      await this.chatService
        .invalidateRoomAccessCache(userId, 'trip', tripId)
        .catch(() => {});
      await this.chatRedis
        .publish(
          'chat:kick',
          JSON.stringify({
            room_type: 'trip',
            room_id: tripId,
            user_id: userId,
          }),
        )
        .catch(() => {});

      return { success: true as const };
    });
  }

  private async assertAdmin(tripId: string, userId: string): Promise<Trip> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_TRIP_ADMIN' });
    }
    return trip;
  }

  // ---- helpers ----

  private async loadFullTrip(
    tripId: string,
    repo?: Repository<Trip>,
  ): Promise<Trip> {
    const r = repo ?? this.tripRepo;
    const trip = await r.findOne({
      where: { id: tripId },
      relations: ['creator'],
    });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });

    const stops = await this.stopRepo.find({
      where: { trip_id: tripId },
      order: { stop_order: 'ASC' },
    });
    (trip as Trip & { stops: TripStop[] }).stops = stops;

    const participants = await this.participantRepo.find({
      where: { trip_id: tripId },
      order: { created_at: 'ASC' },
      relations: ['user'],
    });
    (trip as Trip & { participants: TripParticipant[] }).participants =
      participants;

    return trip;
  }
}
