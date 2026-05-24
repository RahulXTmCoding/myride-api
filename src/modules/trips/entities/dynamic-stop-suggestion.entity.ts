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
import { User } from '../../users/entities/user.entity';

/**
 * DynamicStopSuggestion Entity
 * Represents a suggested stop that requires voting
 * FR-053 to FR-062
 */
@Entity('dynamic_stop_suggestions')
export class DynamicStopSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip: Trip;

  @Column({ type: 'uuid' })
  @Index()
  trip_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'suggested_by_id' })
  suggested_by: User;

  @Column({ type: 'uuid' })
  suggested_by_id: string;

  @Column({ type: 'varchar', length: 200 })
  stop_name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // Suggested stop location
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  location: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string;

  // Insert after which stop in the route
  @Column({ type: 'int', nullable: true })
  insert_after_stop_order: number;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index()
  status: 'pending' | 'approved' | 'rejected' | 'expired';

  // Voting results
  @Column({ type: 'jsonb', default: [] })
  votes: Array<{
    user_id: string;
    vote: 'reroute' | 'continue';
    voted_at: string;
  }>;

  @Column({ type: 'int', default: 0 })
  reroute_votes: number;

  @Column({ type: 'int', default: 0 })
  continue_votes: number;

  // Auto-expire after X minutes
  @Column({ type: 'timestamp with time zone', nullable: true })
  expires_at: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  resolved_at: Date;
}
