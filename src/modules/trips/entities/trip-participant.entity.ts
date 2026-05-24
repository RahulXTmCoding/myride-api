import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Trip } from './trip.entity';
import { User } from '../../users/entities/user.entity';

/**
 * TripParticipant Entity
 * Represents a user's participation in a trip
 */
@Entity('trip_participants')
@Unique(['trip_id', 'user_id'])
export class TripParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip: Trip;

  @Column({ type: 'uuid' })
  @Index()
  trip_id: string;

  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid' })
  @Index()
  user_id: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index()
  status: 'pending' | 'approved' | 'rejected' | 'left';

  @Column({ type: 'varchar', length: 20, default: 'member' })
  role: 'admin' | 'member';

  @Column({ type: 'timestamp with time zone', nullable: true })
  joined_at: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  left_at: Date;

  // Payment status (if trip is paid)
  @Column({ type: 'varchar', length: 20, nullable: true })
  payment_status: 'pending' | 'paid' | 'refunded' | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  payment_id: string; // Stripe payment intent ID

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;
}
