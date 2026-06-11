import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, ILike } from 'typeorm';
import { Community } from './entities/community.entity';
import { CommunityMember } from './entities/community-member.entity';
import { CommunityInvite } from './entities/community-invite.entity';
import { User } from '../users/entities/user.entity';
import { CreateCommunityDto, UpdateCommunityDto, InviteMembersDto } from './dto/community.dto';

/** Produce a URL-safe slug from an arbitrary name */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

@Injectable()
export class CommunityService {
  constructor(
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly memberRepo: Repository<CommunityMember>,
    @InjectRepository(CommunityInvite)
    private readonly inviteRepo: Repository<CommunityInvite>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  // ── Create ──────────────────────────────────────────────────────────────

  async create(dto: CreateCommunityDto, creatorId: string): Promise<Community> {
    let slug = slugify(dto.name);

    // Ensure slug uniqueness with numeric suffix
    const existing = await this.communityRepo.findOne({ where: { slug } });
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const community = qr.manager.create(Community, {
        name: dto.name,
        slug,
        description: dto.description,
        avatar_url: dto.avatar_url,
        join_type: dto.join_type ?? 'invite_only',
        created_by_user_id: creatorId,
        member_count: 1,
      });
      const saved = await qr.manager.save(community);

      // Creator is automatically an admin member
      const member = qr.manager.create(CommunityMember, {
        community_id: saved.id,
        user_id: creatorId,
        role: 'admin',
        is_active: true,
      });
      await qr.manager.save(member);

      await qr.commitTransaction();
      return saved;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ── List (mine + discover) ──────────────────────────────────────────────

  async findMine(userId: string): Promise<Community[]> {
    const memberships = await this.memberRepo.find({
      where: { user_id: userId, is_active: true },
      relations: ['community'],
      order: { joined_at: 'DESC' },
    });
    return memberships
      .map((m) => m.community)
      .filter((c) => c && c.is_active);
  }

  async discover(
    search?: string,
    limit = 20,
    offset = 0,
  ): Promise<{ communities: Community[]; total: number }> {
    const qb = this.communityRepo
      .createQueryBuilder('c')
      .where('c.is_active = true AND c.join_type = :jt', { jt: 'open' })
      .orderBy('c.member_count', 'DESC')
      .skip(offset)
      .take(Math.min(limit, 50));

    if (search) {
      qb.andWhere('(c.name ILIKE :q OR c.description ILIKE :q)', {
        q: `%${search}%`,
      });
    }

    const [communities, total] = await qb.getManyAndCount();
    return { communities, total };
  }

  // ── Detail ──────────────────────────────────────────────────────────────

  async findOne(id: string): Promise<Community> {
    const community = await this.communityRepo.findOne({ where: { id, is_active: true } });
    if (!community) throw new NotFoundException('Community not found');
    return community;
  }

  // ── Update ──────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateCommunityDto, userId: string): Promise<Community> {
    const community = await this.findOne(id);
    this.assertAdmin(community, userId);

    if (dto.name !== undefined) community.name = dto.name;
    if (dto.description !== undefined) community.description = dto.description;
    if (dto.avatar_url !== undefined) community.avatar_url = dto.avatar_url;
    if (dto.join_type !== undefined) community.join_type = dto.join_type;

    return this.communityRepo.save(community);
  }

  // ── Delete ──────────────────────────────────────────────────────────────

  async remove(id: string, userId: string): Promise<void> {
    const community = await this.findOne(id);
    this.assertAdmin(community, userId);
    community.is_active = false;
    await this.communityRepo.save(community);
  }

  // ── Join (open communities) ─────────────────────────────────────────────

  async join(communityId: string, userId: string): Promise<CommunityMember> {
    const community = await this.findOne(communityId);
    if (community.join_type !== 'open') {
      throw new ForbiddenException('This community requires an invite to join');
    }

    const existing = await this.memberRepo.findOne({
      where: { community_id: communityId, user_id: userId },
    });
    if (existing) {
      if (existing.is_active) throw new ConflictException('Already a member');
      // Rejoin
      existing.is_active = true;
      return this.memberRepo.save(existing);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const member = qr.manager.create(CommunityMember, {
        community_id: communityId,
        user_id: userId,
        role: 'member',
        is_active: true,
      });
      const saved = await qr.manager.save(member);
      await qr.manager.increment(Community, { id: communityId }, 'member_count', 1);
      await qr.commitTransaction();
      return saved;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ── Leave ───────────────────────────────────────────────────────────────

  async leave(communityId: string, userId: string): Promise<void> {
    const community = await this.findOne(communityId);
    // Creator cannot leave
    if (community.created_by_user_id === userId) {
      throw new ForbiddenException('Community creator cannot leave. Transfer ownership first or delete the community.');
    }

    const member = await this.memberRepo.findOne({
      where: { community_id: communityId, user_id: userId, is_active: true },
    });
    if (!member) throw new NotFoundException('You are not a member of this community');

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      member.is_active = false;
      await qr.manager.save(member);
      await qr.manager.decrement(Community, { id: communityId }, 'member_count', 1);
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ── Members list ────────────────────────────────────────────────────────

  async listMembers(
    communityId: string,
    userId: string,
  ): Promise<CommunityMember[]> {
    await this.assertMember(communityId, userId);
    return this.memberRepo.find({
      where: { community_id: communityId, is_active: true },
      relations: ['user'],
      order: { role: 'ASC', joined_at: 'ASC' },
    });
  }

  // ── Invite ──────────────────────────────────────────────────────────────

  async invite(
    communityId: string,
    dto: InviteMembersDto,
    invitedByUserId: string,
  ): Promise<{ invited: number; already_members: number; already_invited: number }> {
    const community = await this.findOne(communityId);
    await this.assertMemberOrAdmin(community, invitedByUserId);

    let invited = 0;
    let already_members = 0;
    let already_invited = 0;

    for (const phone of dto.phones) {
      // Check if user with this phone already exists
      const user = await this.userRepo.findOne({ where: { phone } });
      const existingUserId = user?.id ?? null;

      if (existingUserId) {
        // Check if already a member
        const isMember = await this.memberRepo.findOne({
          where: { community_id: communityId, user_id: existingUserId, is_active: true },
        });
        if (isMember) { already_members++; continue; }
      }

      // Check for existing pending invite
      const existingInvite = await this.inviteRepo.findOne({
        where: { community_id: communityId, phone, status: 'pending' },
      });
      if (existingInvite) { already_invited++; continue; }

      // If open community and user exists → auto-add as member
      if (community.join_type === 'open' && existingUserId) {
        await this.join(communityId, existingUserId);
        invited++;
        continue;
      }

      // Create invite record
      const invite = this.inviteRepo.create({
        community_id: communityId,
        invited_by_user_id: invitedByUserId,
        phone,
        user_id: existingUserId ?? undefined,
        status: 'pending',
      });
      await this.inviteRepo.save(invite);

      // If user already registered, auto-accept for invite_only via the invite record
      // (they still need to accept explicitly in the app — the invite shows up in their list)
      invited++;
    }

    return { invited, already_members, already_invited };
  }

  // ── Accept / Reject invite ──────────────────────────────────────────────

  async respondToInvite(
    inviteId: string,
    userId: string,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const invite = await this.inviteRepo.findOne({
      where: [
        { id: inviteId, user_id: userId, status: 'pending' },
        { id: inviteId, phone: user.phone, status: 'pending' },
      ],
    });
    if (!invite) throw new NotFoundException('Invite not found or already responded');

    invite.status = action === 'accept' ? 'accepted' : 'rejected';
    invite.user_id = userId;
    invite.responded_at = new Date();
    await this.inviteRepo.save(invite);

    if (action === 'accept') {
      await this.join(invite.community_id, userId);
    }
  }

  // ── Kick member (admin) ─────────────────────────────────────────────────

  async kickMember(
    communityId: string,
    targetUserId: string,
    adminUserId: string,
  ): Promise<void> {
    const community = await this.findOne(communityId);
    this.assertAdmin(community, adminUserId);

    if (targetUserId === community.created_by_user_id) {
      throw new ForbiddenException('Cannot kick the community creator');
    }

    const member = await this.memberRepo.findOne({
      where: { community_id: communityId, user_id: targetUserId, is_active: true },
    });
    if (!member) throw new NotFoundException('Member not found');

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      member.is_active = false;
      await qr.manager.save(member);
      await qr.manager.decrement(Community, { id: communityId }, 'member_count', 1);
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ── Membership check (used by ChatService) ─────────────────────────────

  async isMember(communityId: string, userId: string): Promise<boolean> {
    const member = await this.memberRepo.findOne({
      where: { community_id: communityId, user_id: userId, is_active: true },
    });
    return !!member;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private assertAdmin(community: Community, userId: string): void {
    if (community.created_by_user_id !== userId) {
      throw new ForbiddenException('Only the community admin can perform this action');
    }
  }

  private async assertMember(communityId: string, userId: string): Promise<void> {
    const is = await this.isMember(communityId, userId);
    if (!is) throw new ForbiddenException('You are not a member of this community');
  }

  private async assertMemberOrAdmin(community: Community, userId: string): Promise<void> {
    if (community.created_by_user_id === userId) return;
    await this.assertMember(community.id, userId);
  }
}
