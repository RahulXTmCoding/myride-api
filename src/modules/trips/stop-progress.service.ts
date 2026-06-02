import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { Trip } from './entities/trip.entity';
import { TripStop } from './entities/trip-stop.entity';
import { TripParticipant } from './entities/trip-participant.entity';
import { UserStopProgress } from './entities/user-stop-progress.entity';
import { CompleteStopDto } from './dto/complete-stop.dto';

/**
 * StopProgressService — per-user, per-stop progress tracking (FR-047–052).
 *
 * Model: one `user_stop_progress` row per (user, stop). Statuses cycle:
 *   pending → current → completed
 *
 * Lifecycle:
 *  - First call to `ensureRowsExist` (lazily by member, or eagerly on approve)
 *    seeds rows so the UI always has a complete set to render. Stop 1 = current.
 *  - `markComplete(stopId, userId)` flips current → completed and advances
 *    the next pending stop to current. Idempotent.
 *  - Admin aggregate uses a single GROUP-BY query over the trip's stops.
 */
@Injectable()
export class StopProgressService {
  private readonly logger = new Logger(StopProgressService.name);

  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripStop)
    private readonly stopRepo: Repository<TripStop>,
    @InjectRepository(TripParticipant)
    private readonly participantRepo: Repository<TripParticipant>,
    @InjectRepository(UserStopProgress)
    private readonly progressRepo: Repository<UserStopProgress>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Seed progress rows for a user (called on approve, plus defensively on read).
   * The first stop becomes 'current', the rest 'pending'.
   * Idempotent — uses ON CONFLICT DO NOTHING.
   */
  async ensureRowsExist(tripId: string, userId: string): Promise<void> {
    const stops = await this.stopRepo.find({
      where: { trip_id: tripId },
      order: { stop_order: 'ASC' },
    });
    if (stops.length === 0) return;

    // Bulk upsert — INSERT ... ON CONFLICT DO NOTHING.
    // We pre-shape values to avoid building dynamic SQL.
    const values = stops.map((s, idx) => ({
      stop_id: s.id,
      user_id: userId,
      status: (idx === 0 ? 'current' : 'pending') as UserStopProgress['status'],
    }));

    // Use query builder so the unique (stop_id, user_id) constraint takes care of dedupe.
    await this.progressRepo
      .createQueryBuilder()
      .insert()
      .into(UserStopProgress)
      .values(values)
      .orIgnore() // ON CONFLICT DO NOTHING
      .execute();
  }

  /**
   * Get current user's progress for every stop in a trip, sorted by stop_order.
   */
  async getMyProgress(
    tripId: string,
    userId: string,
  ): Promise<
    Array<{
      stop_id: string;
      stop_order: number;
      stop_name: string;
      status: string;
      completed_at: Date | null;
    }>
  > {
    await this.assertMember(tripId, userId);
    // Seed lazily for users approved before this feature existed.
    await this.ensureRowsExist(tripId, userId);

    // Single query, joined.
    const rows = await this.progressRepo
      .createQueryBuilder('p')
      .innerJoin('trip_stops', 's', 's.id = p.stop_id')
      .where('s.trip_id = :tripId', { tripId })
      .andWhere('p.user_id = :userId', { userId })
      .orderBy('s.stop_order', 'ASC')
      .select([
        'p.stop_id AS stop_id',
        's.stop_order AS stop_order',
        's.name AS stop_name',
        'p.status AS status',
        'p.completed_at AS completed_at',
      ])
      .getRawMany();

    return rows.map((r) => ({
      stop_id: r.stop_id,
      stop_order: Number(r.stop_order),
      stop_name: r.stop_name,
      status: r.status,
      completed_at: r.completed_at ? new Date(r.completed_at) : null,
    }));
  }

  /**
   * Admin-only aggregate — "3/5 members completed Stop 2".
   * Returns one row per stop with completed_count / current_count / pending_count.
   */
  async getAllProgress(
    tripId: string,
    adminId: string,
  ): Promise<
    Array<{
      stop_id: string;
      stop_order: number;
      stop_name: string;
      completed_count: number;
      current_count: number;
      pending_count: number;
    }>
  > {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id !== adminId) {
      throw new ForbiddenException({ error: 'NOT_TRIP_ADMIN' });
    }

    const rows = await this.stopRepo
      .createQueryBuilder('s')
      .leftJoin('user_stop_progress', 'p', 'p.stop_id = s.id')
      .where('s.trip_id = :tripId', { tripId })
      .groupBy('s.id')
      .orderBy('s.stop_order', 'ASC')
      .select([
        's.id AS stop_id',
        's.stop_order AS stop_order',
        's.name AS stop_name',
        `SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed_count`,
        `SUM(CASE WHEN p.status = 'current' THEN 1 ELSE 0 END) AS current_count`,
        `SUM(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END) AS pending_count`,
      ])
      .getRawMany();

    return rows.map((r) => ({
      stop_id: r.stop_id,
      stop_order: Number(r.stop_order),
      stop_name: r.stop_name,
      completed_count: Number(r.completed_count ?? 0),
      current_count: Number(r.current_count ?? 0),
      pending_count: Number(r.pending_count ?? 0),
    }));
  }

  /**
   * Mark a stop completed for the current user. Auto-advances the next
   * pending stop to current. Idempotent — re-completing an already-completed
   * stop is a no-op (200 with the same row).
   */
  async markComplete(
    tripId: string,
    userId: string,
    stopId: string,
    dto: CompleteStopDto,
  ): Promise<UserStopProgress> {
    await this.assertMember(tripId, userId);

    // Stop must belong to this trip
    const stop = await this.stopRepo.findOne({ where: { id: stopId, trip_id: tripId } });
    if (!stop) {
      throw new NotFoundException({ error: 'STOP_NOT_FOUND' });
    }

    return this.dataSource.transaction(async (manager) => {
      // Seed if missing
      await this.ensureRowsExist(tripId, userId);

      const progress = await manager.findOne(UserStopProgress, {
        where: { stop_id: stopId, user_id: userId },
      });
      if (!progress) {
        // Shouldn't happen after ensureRowsExist — defensive.
        throw new NotFoundException({ error: 'PROGRESS_ROW_MISSING' });
      }

      // Idempotent: already done? just return.
      if (progress.status === 'completed') return progress;

      // Update this row → completed
      progress.status = 'completed';
      progress.completed_at = new Date();
      if (dto.notes) progress.notes = dto.notes;

      if (dto.location) {
        // Use raw SQL to set the geography point
        await manager.query(
          `UPDATE user_stop_progress
             SET completion_location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
           WHERE id = $3`,
          [dto.location.longitude, dto.location.latitude, progress.id],
        );
      }
      await manager.save(UserStopProgress, progress);

      // Advance the next pending stop (by stop_order) to current.
      // We do it in raw SQL to avoid an N+1.
      await manager.query(
        `UPDATE user_stop_progress
            SET status = 'current', updated_at = NOW()
          WHERE id = (
            SELECT usp.id
              FROM user_stop_progress usp
              JOIN trip_stops ts ON ts.id = usp.stop_id
             WHERE ts.trip_id = $1
               AND usp.user_id = $2
               AND usp.status = 'pending'
             ORDER BY ts.stop_order ASC
             LIMIT 1
          )`,
        [tripId, userId],
      );

      return progress;
    });
  }

  private async assertMember(tripId: string, userId: string): Promise<void> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id === userId) return; // creator is implicitly a member
    const participant = await this.participantRepo.findOne({
      where: { trip_id: tripId, user_id: userId, status: 'approved' },
    });
    if (!participant) {
      throw new ForbiddenException({ error: 'NOT_TRIP_MEMBER' });
    }
  }
}
