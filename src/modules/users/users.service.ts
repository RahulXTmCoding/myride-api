import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UpdateProfileDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** Public profile — safe fields only */
  async findById(id: string): Promise<Partial<User>> {
    const user = await this.userRepo.findOne({ where: { id, is_active: true } });
    if (!user) throw new NotFoundException('User not found');
    return this.toPublic(user);
  }

  /** Update authenticated user's own profile */
  async updateMe(userId: string, dto: UpdateProfileDto): Promise<Partial<User>> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (trimmed.length < 1 || trimmed.length > 100) {
        throw new BadRequestException({ error: 'INVALID_NAME', message: 'Name must be 1-100 chars' });
      }
      user.name = trimmed;
      // Mark onboarding complete once name is set
      user.is_onboarding_complete = true;
    }

    if (dto.bio !== undefined) user.bio = (dto.bio.trim() || null) as any;
    if (dto.avatar_url !== undefined) user.profile_photo_url = dto.avatar_url;
    if (dto.emergency_contacts !== undefined) user.emergency_contacts = dto.emergency_contacts;
    if (dto.push_token !== undefined) user.push_token = (dto.push_token || null) as any;

    const saved = await this.userRepo.save(user);
    return this.toPublic(saved);
  }

  /** Lookup user by push token (internal use for notifications) */
  async findPushToken(userId: string): Promise<string | null> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'push_token'],
    });
    return user?.push_token ?? null;
  }

  /** Bulk lookup push tokens for a list of user IDs */
  async findPushTokens(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const users = await this.userRepo
      .createQueryBuilder('u')
      .select(['u.id', 'u.push_token'])
      .where('u.id IN (:...ids)', { ids: userIds })
      .andWhere('u.push_token IS NOT NULL')
      .getMany();
    const map = new Map<string, string>();
    for (const u of users) {
      if (u.push_token) map.set(u.id, u.push_token);
    }
    return map;
  }

  private toPublic(user: User): Partial<User> {
    return {
      id: user.id,
      phone: user.phone,
      name: user.name,
      bio: user.bio,
      profile_photo_url: user.profile_photo_url,
      is_verified: user.is_verified,
      is_active: user.is_active,
      rating: user.rating,
      total_trips: user.total_trips,
      total_trips_created: user.total_trips_created,
      emergency_contacts: user.emergency_contacts,
      preferences: user.preferences,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }
}
