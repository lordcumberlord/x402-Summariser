export type TelegramStoredMessage = {
  messageId: number;
  text: string;
  timestampMs: number;
  authorId?: number;
  authorUsername?: string | null;
  authorDisplay?: string | null;
  replyToMessageId?: number;
  reactionCount?: number; // Total number of reactions on this message
};

const MAX_MESSAGES_PER_CHAT = 1000;

const messageStore = new Map<number, TelegramStoredMessage[]>();

export function addTelegramMessage(chatId: number, message: TelegramStoredMessage) {
  const existing = messageStore.get(chatId) ?? [];
  existing.push(message);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = existing.filter((entry) => entry.timestampMs >= cutoff);
  if (recent.length > MAX_MESSAGES_PER_CHAT) {
    recent.splice(0, recent.length - MAX_MESSAGES_PER_CHAT);
  }
  messageStore.set(chatId, recent);
}

export function getTelegramMessages(chatId: number) {
  return messageStore.get(chatId) ?? [];
}

export function getTelegramMessagesWithin(chatId: number, lookbackMinutes: number) {
  const now = Date.now();
  const cutoff = now - lookbackMinutes * 60 * 1000;
  return getTelegramMessages(chatId).filter((msg) => msg.timestampMs >= cutoff);
}

export function clearTelegramMessages(chatId: number) {
  messageStore.delete(chatId);
}

export function updateTelegramMessageReactions(
  chatId: number,
  messageId: number,
  reactionCount: number
) {
  const messages = messageStore.get(chatId);
  if (!messages) return;
  
  const message = messages.find((msg) => msg.messageId === messageId);
  if (message) {
    message.reactionCount = reactionCount;
  }
}
