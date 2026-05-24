import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Trip } from './trip.entity';

/**
 * TripShareableLink Entity
 * Allows trips to be shared via unique URL
 * FR-090 to FR-106
 */
@Entity('trip_shareable_links')
export class TripShareableLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip: Trip;

  @Column({ type: 'uuid', unique: true })
  @Index()
  trip_id: string;

  // Cryptographically secure 128-bit token
  @Column({ type: 'varchar', length: 64, unique: true })
  @Index()
  link_token: string;

  @Column({ type: 'varchar', length: 20, default: 'view-only' })
  access_mode: 'view-only' | 'auto-join' | 'password-protected' | 'expiring';

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  password_hash: string; // bcrypt hash

  @Column({ type: 'timestamp with time zone', nullable: true })
  expires_at: Date;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  // Analytics
  @Column({ type: 'int', default: 0 })
  total_views: number;

  @Column({ type: 'int', default: 0 })
  unique_visitors: number;

  @Column({ type: 'int', default: 0 })
  join_requests: number;

  @Column({ type: 'int', default: 0 })
  successful_joins: number;

  @Column({ type: 'timestamp with time zone', nullable: true })
  last_accessed_at: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;
}
