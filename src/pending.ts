export type DiscordCallbackData = {
  applicationId: string;
  channelId: string;
  guildId: string | null;
  lookbackMinutes: number;
  expiresAt: number;
};

export type TelegramCallbackData = {
  chatId: number;
  threadId?: number | null;
  messageId?: number | null;
  username?: string | null;
  lookbackMinutes: number;
  expiresAt: number;
};

export const pendingDiscordCallbacks = new Map<string, DiscordCallbackData>();
export const pendingTelegramCallbacks = new Map<string, TelegramCallbackData>();

