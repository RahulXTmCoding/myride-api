import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Trip Entity
 * Represents a trip (journey) in the myRide platform
 */
@Entity('trips')
export class Trip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 20 })
  @Index()
  trip_type: 'one-way' | 'round-trip';

  @Column({ type: 'varchar', length: 20 })
  @Index()
  visibility: 'public' | 'private';

  @Column({ type: 'boolean', default: false })
  is_paid: boolean;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  trip_price: number; // Fixed price for the entire trip

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index()
  status: 'pending' | 'in-progress' | 'completed' | 'cancelled';

  // Trip creator (admin)
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'creator_id' })
  creator: User;

  @Column({ type: 'uuid' })
  @Index()
  creator_id: string;

  /** Optional: community this trip belongs to (FR-121) */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  community_id: string;

  // Participant limits
  @Column({ type: 'int', default: 20 })
  max_participants: number;

  @Column({ type: 'int', default: 0 })
  current_participants: number;

  // Scheduled start time
  @Column({ type: 'timestamp with time zone', nullable: true })
  scheduled_start_time: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  actual_start_time: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  estimated_end_time: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  actual_end_time: Date;

  // Route information (will be populated by Google Maps API)
  @Column({ type: 'jsonb', nullable: true })
  route_info: {
    distance_km: number;
    estimated_duration_minutes: number;
    polyline: string; // Encoded polyline from Google Maps
  };

  // Trip metadata
  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    vehicle_type?: 'bike' | 'car' | 'van' | 'other';
    tags?: string[]; // e.g., ['adventure', 'coastal', 'weekend']
    difficulty_level?: 'easy' | 'moderate' | 'hard';
  };

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  deleted_at: Date;
}
