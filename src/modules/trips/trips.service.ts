import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';

import { Trip } from './entities/trip.entity';
import { TripStop } from './entities/trip-stop.entity';
import { TripParticipant } from './entities/trip-participant.entity';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { ListTripsDto } from './dto/list-trips.dto';

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

  async list(userId: string, dto: ListTripsDto): Promise<{ items: Trip[]; total: number }> {
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

    if (dto.status) qb.andWhere('trip.status = :status', { status: dto.status });
    if (dto.visibility) qb.andWhere('trip.visibility = :visibility', { visibility: dto.visibility });

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

  async update(tripId: string, userId: string, dto: UpdateTripDto): Promise<Trip> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_TRIP_ADMIN' });
    }

    // FR-010: only editable up to 6h before departure
    if (
      trip.scheduled_start_time &&
      trip.scheduled_start_time.getTime() - Date.now() < TripsService.EDIT_WINDOW_MS &&
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

  // ---- helpers ----

  private async loadFullTrip(tripId: string, repo?: Repository<Trip>): Promise<Trip> {
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
    });
    (trip as Trip & { participants: TripParticipant[] }).participants = participants;

    return trip;
  }
}
