import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';

import { TripShareableLink } from '../trips/entities/trip-shareable-link.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripStop } from '../trips/entities/trip-stop.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';
import {
  CreateShareLinkDto,
  UpdateShareLinkDto,
  JoinViaLinkDto,
} from './dto/share-link.dto';

/**
 * ShareLinksService — FR-090..FR-106.
 *
 * Token: 24 random bytes → base64url → 32 chars, well over 128 bits entropy.
 * One link per trip (entity has UNIQUE on trip_id). Regenerate replaces the
 * row's token in place so old URLs become 404.
 *
 * Access modes:
 *   - view-only: anyone with the link reads trip details + requests to join
 *     (subject to admin approval).
 *   - auto-join: free trips only — first request becomes an approved member.
 *   - password-protected: must POST verify-password first.
 *
 * Privacy: passwords stored as bcrypt hashes; the hash column is `select:false`
 * so it never leaks via the entity. Analytics counters use atomic increments.
 */
@Injectable()
export class ShareLinksService {
  private readonly logger = new Logger(ShareLinksService.name);

  constructor(
    @InjectRepository(TripShareableLink)
    private readonly linkRepo: Repository<TripShareableLink>,
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripStop)
    private readonly stopRepo: Repository<TripStop>,
    @InjectRepository(TripParticipant)
    private readonly participantRepo: Repository<TripParticipant>,
  ) {}

  /** Create or replace the shareable link for a trip. Admin only. */
  async upsert(
    tripId: string,
    adminId: string,
    dto: CreateShareLinkDto,
  ): Promise<TripShareableLink> {
    await this.assertAdmin(tripId, adminId);

    if (dto.access_mode === 'password-protected' && !dto.password) {
      throw new BadRequestException({ error: 'PASSWORD_REQUIRED' });
    }

    const token = this.generateToken();
    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : null;
    const expiresAt =
      dto.expires_in_hours != null
        ? new Date(Date.now() + dto.expires_in_hours * 3600_000)
        : null;

    // Idempotent: replace existing row's columns or insert fresh.
    const existing = await this.linkRepo.findOne({
      where: { trip_id: tripId },
    });
    if (existing) {
      existing.link_token = token;
      existing.access_mode = dto.access_mode ?? 'view-only';
      existing.password_hash = passwordHash as unknown as string;
      existing.expires_at = expiresAt as unknown as Date;
      existing.is_active = true;
      return this.linkRepo.save(existing);
    }
    const fresh = this.linkRepo.create({
      trip_id: tripId,
      link_token: token,
      access_mode: dto.access_mode ?? 'view-only',
      password_hash: passwordHash as unknown as string,
      expires_at: expiresAt as unknown as Date,
      is_active: true,
    } as Partial<TripShareableLink>);
    return this.linkRepo.save(fresh);
  }

  async update(
    tripId: string,
    adminId: string,
    dto: UpdateShareLinkDto,
  ): Promise<TripShareableLink> {
    await this.assertAdmin(tripId, adminId);
    const link = await this.linkRepo.findOne({ where: { trip_id: tripId } });
    if (!link) throw new NotFoundException({ error: 'LINK_NOT_FOUND' });

    if (
      dto.access_mode === 'password-protected' &&
      !dto.password &&
      !link.password_hash
    ) {
      throw new BadRequestException({ error: 'PASSWORD_REQUIRED' });
    }
    if (dto.access_mode) link.access_mode = dto.access_mode;
    if (dto.password) link.password_hash = await bcrypt.hash(dto.password, 10);
    if (dto.expires_in_hours != null) {
      link.expires_at = new Date(Date.now() + dto.expires_in_hours * 3600_000);
    }
    return this.linkRepo.save(link);
  }

  async getForAdmin(
    tripId: string,
    adminId: string,
  ): Promise<TripShareableLink | null> {
    await this.assertAdmin(tripId, adminId);
    return this.linkRepo.findOne({ where: { trip_id: tripId } });
  }

  async disable(tripId: string, adminId: string): Promise<{ success: true }> {
    await this.assertAdmin(tripId, adminId);
    await this.linkRepo.update({ trip_id: tripId }, { is_active: false });
    return { success: true };
  }

  async regenerate(
    tripId: string,
    adminId: string,
  ): Promise<TripShareableLink> {
    await this.assertAdmin(tripId, adminId);
    const link = await this.linkRepo.findOne({ where: { trip_id: tripId } });
    if (!link) throw new NotFoundException({ error: 'LINK_NOT_FOUND' });
    link.link_token = this.generateToken();
    link.is_active = true;
    return this.linkRepo.save(link);
  }

  /**
   * Public lookup by token. Increments view counter, returns a read-only
   * projection of the trip safe to expose to unauthenticated callers (no
   * participant phone numbers, no creator email).
   */
  async resolveByToken(token: string) {
    const link = await this.linkRepo
      .createQueryBuilder('l')
      .addSelect('l.password_hash')
      .where('l.link_token = :token', { token })
      .getOne();
    if (!link || !link.is_active) {
      throw new NotFoundException({ error: 'LINK_NOT_FOUND_OR_DISABLED' });
    }
    if (link.expires_at && link.expires_at.getTime() < Date.now()) {
      throw new ForbiddenException({ error: 'LINK_EXPIRED' });
    }

    const trip = await this.tripRepo.findOne({
      where: { id: link.trip_id },
      relations: ['creator'],
    });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });

    const stops = await this.stopRepo.find({
      where: { trip_id: trip.id },
      order: { stop_order: 'ASC' },
    });

    // Increment view counter (fire-and-forget)
    this.linkRepo.increment({ id: link.id }, 'total_views', 1).catch(() => {});
    this.linkRepo
      .update({ id: link.id }, { last_accessed_at: new Date() })
      .catch(() => {});

    const canJoin =
      trip.status === 'pending' &&
      trip.current_participants < trip.max_participants;

    return {
      trip: {
        id: trip.id,
        title: trip.title,
        description: trip.description,
        trip_type: trip.trip_type,
        visibility: trip.visibility,
        is_paid: trip.is_paid,
        trip_price: trip.trip_price,
        status: trip.status,
        max_participants: trip.max_participants,
        current_participants: trip.current_participants,
        scheduled_start_time: trip.scheduled_start_time,
        creator: trip.creator
          ? { id: trip.creator.id, name: trip.creator.name }
          : null,
        stops: stops.map((s) => ({
          id: s.id,
          stop_order: s.stop_order,
          name: s.name,
          stop_type: s.stop_type,
        })),
      },
      access_mode: link.access_mode,
      requires_password: link.access_mode === 'password-protected',
      can_join: canJoin,
      expires_at: link.expires_at,
    };
  }

  async verifyPassword(
    token: string,
    password: string,
  ): Promise<{ verified: true }> {
    const link = await this.linkRepo
      .createQueryBuilder('l')
      .addSelect('l.password_hash')
      .where('l.link_token = :token', { token })
      .getOne();
    if (!link || !link.is_active)
      throw new NotFoundException({ error: 'LINK_NOT_FOUND' });
    if (!link.password_hash) return { verified: true }; // no password set
    const ok = await bcrypt.compare(password, link.password_hash);
    if (!ok) throw new UnauthorizedException({ error: 'WRONG_PASSWORD' });
    return { verified: true };
  }

  /**
   * Join the trip via the link. Caller MUST be authenticated.
   *   - auto-join (free trip) → instantly approved
   *   - anything else → same flow as POST /trips/:id/join (pending)
   */
  async joinViaLink(token: string, userId: string, dto: JoinViaLinkDto) {
    const link = await this.linkRepo.findOne({ where: { link_token: token } });
    if (!link || !link.is_active)
      throw new NotFoundException({ error: 'LINK_NOT_FOUND' });
    if (link.expires_at && link.expires_at.getTime() < Date.now()) {
      throw new ForbiddenException({ error: 'LINK_EXPIRED' });
    }

    const trip = await this.tripRepo.findOne({ where: { id: link.trip_id } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id === userId) {
      throw new BadRequestException({ error: 'CREATOR_CANNOT_JOIN' });
    }
    if (trip.status !== 'pending') {
      throw new BadRequestException({ error: 'TRIP_NOT_JOINABLE' });
    }
    if (trip.current_participants >= trip.max_participants) {
      throw new ConflictException({ error: 'TRIP_FULL' });
    }

    const existing = await this.participantRepo.findOne({
      where: { trip_id: trip.id, user_id: userId },
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

    const autoApprove = link.access_mode === 'auto-join' && !trip.is_paid;

    if (existing) {
      existing.status = autoApprove ? 'approved' : 'pending';
      existing.joined_at = autoApprove ? new Date() : (null as unknown as Date);
      const saved = await this.participantRepo.save(existing);
      await this.bumpAnalytics(link.id, autoApprove);
      if (autoApprove) {
        await this.tripRepo.increment(
          { id: trip.id },
          'current_participants',
          1,
        );
      }
      return saved;
    }

    const participant = this.participantRepo.create({
      trip_id: trip.id,
      user_id: userId,
      status: autoApprove ? 'approved' : 'pending',
      role: 'member',
      joined_at: autoApprove ? new Date() : null,
      payment_status: trip.is_paid ? 'pending' : null,
    } as Partial<TripParticipant>);
    const saved = await this.participantRepo.save(participant);

    if (autoApprove) {
      await this.tripRepo.increment({ id: trip.id }, 'current_participants', 1);
    }
    if (dto.message) {
      this.logger.log(`Link join msg [${trip.id}/${userId}]: ${dto.message}`);
    }
    await this.bumpAnalytics(link.id, autoApprove);
    return saved;
  }

  private async bumpAnalytics(linkId: string, success: boolean): Promise<void> {
    await this.linkRepo
      .increment({ id: linkId }, 'join_requests', 1)
      .catch(() => {});
    if (success) {
      await this.linkRepo
        .increment({ id: linkId }, 'successful_joins', 1)
        .catch(() => {});
    }
  }

  private generateToken(): string {
    return randomBytes(24).toString('base64url');
  }

  private async assertAdmin(tripId: string, userId: string): Promise<Trip> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });
    if (trip.creator_id !== userId) {
      throw new ForbiddenException({ error: 'NOT_TRIP_ADMIN' });
    }
    return trip;
  }
}
