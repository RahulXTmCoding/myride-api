import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * User Entity
 * Represents a user in the myRide platform
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 15, unique: true })
  @Index()
  phone: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  profile_photo_url: string;

  @Column({ type: 'text', nullable: true })
  bio: string;

  @Column({ type: 'boolean', default: false })
  is_verified: boolean;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  // Location tracking (PostGIS geography type)
  // Uses POINT(longitude, latitude) format
  // SRID 4326 is WGS 84 (standard GPS coordinates)
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  @Index({ spatial: true })
  location: string; // Will be stored as POINT(lng lat)

  @Column({ type: 'timestamp with time zone', nullable: true })
  last_location_update: Date;

  // Emergency contacts (stored as JSON)
  @Column({ type: 'jsonb', nullable: true })
  emergency_contacts: Array<{
    name: string;
    phone: string;
    relationship?: string;
  }>;

  // User preferences
  @Column({ type: 'jsonb', nullable: true })
  preferences: {
    notifications_enabled?: boolean;
    location_sharing_enabled?: boolean;
    theme?: 'light' | 'dark';
  };

  // Rating and reputation
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.0 })
  rating: number;

  @Column({ type: 'int', default: 0 })
  total_trips: number;

  @Column({ type: 'int', default: 0 })
  total_trips_created: number;

  // Authentication
  @Column({ type: 'varchar', length: 500, nullable: true, select: false })
  refresh_token: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  deleted_at: Date;
}
