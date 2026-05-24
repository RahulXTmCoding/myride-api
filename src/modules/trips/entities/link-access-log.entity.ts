import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { TripShareableLink } from './trip-shareable-link.entity';
import { User } from '../../users/entities/user.entity';

/**
 * LinkAccessLog Entity
 * Audit trail for shareable link access
 * FR-104: Tracks every link access for analytics and security
 */
@Entity('link_access_log')
export class LinkAccessLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => TripShareableLink, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'link_id' })
  link: TripShareableLink;

  @Column({ type: 'uuid' })
  @Index()
  link_id: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  user_id: string; // null if not logged in

  @Column({ type: 'inet', nullable: true })
  ip_address: string;

  @Column({ type: 'text', nullable: true })
  user_agent: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  referrer: string; // whatsapp, instagram, direct, etc.

  @Column({ type: 'varchar', length: 50 })
  action: string; // 'view', 'join_request', 'password_attempt'

  @Column({ type: 'jsonb', nullable: true })
  metadata: any; // Additional context

  @CreateDateColumn({ type: 'timestamp with time zone' })
  accessed_at: Date;
}
