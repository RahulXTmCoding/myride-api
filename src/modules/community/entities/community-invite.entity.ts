import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Community } from './community.entity';

/**
 * CommunityInvite Entity — FR-117..FR-120
 * Tracks invitations sent to phone numbers for a community.
 * When the invitee registers / is already registered, user_id is populated.
 */
@Entity('community_invite')
export class CommunityInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  community_id: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'community_id' })
  community: Community;

  @Column({ type: 'uuid' })
  @Index()
  invited_by_user_id: string;

  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'invited_by_user_id' })
  invited_by: User;

  /** Phone number the invite was sent to (E.164 format) */
  @Column({ type: 'varchar', length: 20 })
  @Index()
  phone: string;

  /** Populated once the invitee has a user account */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  user_id: string;

  @ManyToOne(() => User, { nullable: true, eager: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index()
  status: 'pending' | 'accepted' | 'rejected';

  @CreateDateColumn({ type: 'timestamp with time zone' })
  invited_at: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  responded_at: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;
}
