import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { TripStop } from './trip-stop.entity';
import { User } from '../../users/entities/user.entity';

/**
 * UserStopProgress Entity
 * Tracks individual user's progress through trip stops
 * Each user marks stops independently
 */
@Entity('user_stop_progress')
@Unique(['stop_id', 'user_id'])
export class UserStopProgress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => TripStop, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'stop_id' })
  stop: TripStop;

  @Column({ type: 'uuid' })
  @Index()
  stop_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid' })
  @Index()
  user_id: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: 'pending' | 'current' | 'completed' | 'skipped';

  @Column({ type: 'timestamp with time zone', nullable: true })
  completed_at: Date;

  // User's location when they marked stop as complete
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  completion_location: string;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;
}
