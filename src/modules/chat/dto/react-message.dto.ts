import { IsIn, IsUUID } from 'class-validator';

/** Supported emoji set — whitelisted to prevent arbitrary string storage */
export const SUPPORTED_REACTIONS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '😡',
  '🔥',
  '🎉',
] as const;
export type SupportedEmoji = (typeof SUPPORTED_REACTIONS)[number];

export class ReactMessageDto {
  @IsUUID('4')
  message_id: string;

  @IsIn(SUPPORTED_REACTIONS)
  emoji: string;
}
