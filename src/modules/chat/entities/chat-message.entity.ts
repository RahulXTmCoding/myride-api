import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export type RoomType = 'trip' | 'community';
export type MessageType = 'text' | 'system';

export interface ReplyToSnapshot {
  id: string;
  content: string; // truncated to 200 chars
  sender_name: string; // denormalized — no join needed at read time
}

/**
 * ChatMessage Entity
 * Generic room-based chat: works for trip chat, community chat, community-trip chat.
 * Room is identified by (room_type, room_id) — no foreign key to a specific table,
 * so the same table serves all chat contexts without schema changes.
 *
 * FR-021 to FR-029, FR-118, FR-119
 */
@Entity('chat_messages')
@Index('idx_chat_messages_room_created', ['roomType', 'roomId', 'createdAt'])
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Room type discriminator.
   * 'trip'      → trip-level chat room (participants only)
   * 'community' → community-level persistent chat (members only)
   */
  @Column({ name: 'room_type', type: 'varchar', length: 20 })
  roomType: RoomType;

  /**
   * UUID of the trip or community this message belongs to.
   * NOT a foreign key — intentional. Allows the same entity to serve
   * multiple room types without polymorphic FK hacks.
   */
  @Column({ name: 'room_id', type: 'uuid' })
  @Index('idx_chat_messages_room_id')
  roomId: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sender_id' })
  sender: User;

  @Column({ name: 'sender_id', type: 'uuid', nullable: true })
  @Index()
  senderId: string;

  @Column({
    name: 'message_type',
    type: 'varchar',
    length: 20,
    default: 'text',
  })
  messageType: MessageType;

  @Column({ type: 'text' })
  content: string;

  /**
   * Reply-to stored as a JSONB snapshot (denormalized).
   * Avoids a JOIN on every message fetch. The snapshot captures what
   * was said at reply-time — intentionally static even if original is edited/deleted.
   */
  @Column({ name: 'reply_to', type: 'jsonb', nullable: true })
  replyTo: ReplyToSnapshot | null;

  @Column({ type: 'jsonb', nullable: false, default: '{}' })
  metadata: Record<string, unknown>;

  @Column({ name: 'is_pinned', default: false })
  isPinned: boolean;

  @Column({ name: 'is_deleted', default: false })
  isDeleted: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({
    name: 'deleted_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  deletedAt: Date | null;
}
