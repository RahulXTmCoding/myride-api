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
 * ChatMessage Entity
 * Stores group chat messages for trips
 * FR-021 to FR-029
 */
@Entity('chat_messages')
export class ChatMessage {
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

  @Column({ type: 'varchar', length: 20, default: 'text' })
  message_type: 'text' | 'location' | 'photo' | 'system';

  @Column({ type: 'text', nullable: true })
  content: string;

  // For location pins and photos
  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    location?: { lat: number; lng: number };
    photo_url?: string;
    reply_to?: string; // message ID
  };

  @Column({ type: 'boolean', default: false })
  is_pinned: boolean;

  @Column({ type: 'boolean', default: false })
  is_deleted: boolean;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  deleted_at: Date;
}
