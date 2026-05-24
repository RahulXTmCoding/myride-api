import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Trip } from '../../trips/entities/trip.entity';
import { User } from '../../users/entities/user.entity';

/**
 * SOSAlert Entity
 * Emergency alerts sent during trips
 * FR-063 to FR-075
 */
@Entity('sos_alerts')
export class SOSAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip: Trip;

  @Column({ type: 'uuid' })
  @Index()
  trip_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'sender_id' })
  sender: User;

  @Column({ type: 'uuid' })
  @Index()
  sender_id: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  @Index()
  status: 'active' | 'resolved' | 'false-alarm';

  // Sender's location when SOS was triggered
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  @Index({ spatial: true })
  location: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string;

  @Column({ type: 'text', nullable: true })
  message: string; // Optional message from sender

  @Column({ type: 'varchar', length: 50, nullable: true })
  alert_type: 'breakdown' | 'accident' | 'medical' | 'other';

  // Track who acknowledged the SOS
  @Column({ type: 'jsonb', default: [] })
  acknowledged_by: Array<{
    user_id: string;
    acknowledged_at: string;
  }>;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  resolved_at: Date;
}
