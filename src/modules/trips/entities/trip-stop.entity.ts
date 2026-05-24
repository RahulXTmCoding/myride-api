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
 * TripStop Entity
 * Represents a stop/checkpoint in a trip
 */
@Entity('trip_stops')
export class TripStop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'trip_id' })
  trip: Trip;

  @Column({ type: 'uuid' })
  @Index()
  trip_id: string;

  @Column({ type: 'int' })
  stop_order: number; // 1, 2, 3, etc.

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // Location (PostGIS geography type)
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  @Index({ spatial: true })
  location: string; // POINT(longitude latitude)

  // Human-readable address
  @Column({ type: 'varchar', length: 500, nullable: true })
  address: string;

  @Column({ type: 'varchar', length: 50 })
  stop_type: 'start' | 'waypoint' | 'fuel' | 'food' | 'rest' | 'destination';

  // Estimated arrival time (calculated by Google Maps)
  @Column({ type: 'timestamp with time zone', nullable: true })
  estimated_arrival_time: Date;

  // Stop duration (how long to stay at this stop)
  @Column({ type: 'int', nullable: true })
  duration_minutes: number;

  @Column({ type: 'boolean', default: false })
  is_mandatory: boolean; // If true, all participants must check in

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;
}
