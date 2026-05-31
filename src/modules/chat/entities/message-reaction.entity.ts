import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';
import { ChatMessage } from './chat-message.entity';
import { User } from '../../users/entities/user.entity';

/**
 * MessageReaction Entity
 * Tracks per-user emoji reactions on chat messages.
 * Unique constraint ensures one reaction per emoji per user per message (toggle).
 */
@Entity('message_reactions')
@Unique('uq_message_reactions_user_emoji', ['messageId', 'userId', 'emoji'])
export class MessageReaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => ChatMessage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message: ChatMessage;

  @Column({ name: 'message_id', type: 'uuid' })
  @Index('idx_message_reactions_message_id')
  messageId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index('idx_message_reactions_user')
  userId: string;

  /** Raw emoji string — whitelisted at DTO level (not here) */
  @Column({ type: 'varchar', length: 10 })
  emoji: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
