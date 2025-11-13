import { Bot, InlineKeyboard } from "grammy";
import { validateLookback } from "./lookback";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import { pendingTelegramCallbacks } from "./pending";
import { addTelegramMessage, updateTelegramMessageReactions } from "./telegramStore";

const DEFAULT_LOOKBACK_MINUTES = 60;

function extractLookback(text: string | undefined) {
  if (!text) return DEFAULT_LOOKBACK_MINUTES;
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return DEFAULT_LOOKBACK_MINUTES;
  const candidate = parts[1];
  const result = validateLookback(candidate);
  if ("error" in result) {
    return result;
  }
  return result.minutes;
}

export function createTelegramBot(options: {
  token: string;
  baseUrl: string;
}) {
  const bot = new Bot(options.token);

  bot.catch((err) => {
    console.error("[telegram] polling error", err.error ?? err);
  });

  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) {
      return next();
    }
    const chatId = msg.chat?.id;
    const text = "text" in msg ? msg.text ?? "" : "";
    // Don't store command messages - they shouldn't be included in summaries
    const trimmed = text.trim();
    if (chatId && trimmed.length > 0 && !trimmed.startsWith("/")) {
      addTelegramMessage(chatId, {
        messageId: msg.message_id,
        text,
        timestampMs: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
        authorId: ctx.from?.id,
        authorUsername: ctx.from?.username ?? null,
        authorDisplay: ctx.from?.first_name
          ? `${ctx.from.first_name}${ctx.from.last_name ? " " + ctx.from.last_name : ""}`
          : ctx.from?.username ?? null,
        replyToMessageId:
          msg.reply_to_message && "message_id" in msg.reply_to_message
            ? msg.reply_to_message.message_id
            : undefined,
      });
    }
    return next();
  });

  // Handle message reactions - track reaction counts for messages
  bot.on("message_reaction", async (ctx) => {
    try {
      const update = ctx.update.message_reaction;
      if (!update) return;
      
      const chatId = update.chat.id;
      const messageId = update.message_id;
      
      // Get current reactions count from the update
      // Telegram provides reaction_counts in the message_reaction update
      const reactionCounts = update.reaction_counts || [];
      const totalReactions = reactionCounts.reduce((sum, rc) => sum + (rc.count || 0), 0);
      
      if (totalReactions > 0) {
        updateTelegramMessageReactions(chatId, messageId, totalReactions);
      } else {
        // No reactions - set to 0
        updateTelegramMessageReactions(chatId, messageId, 0);
      }
    } catch (error) {
      console.warn("[telegram] Error handling message reaction:", error);
    }
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hey! I'm the Luma Event Search Bot. Use /search_events to find events:\n\n" +
      "• /search_events on <topic> - Search events by topic (e.g., crypto, AI)\n" +
      "• /search_events in <place> - Try searching by location (limited support)\n\n" +
      "Note: Location search works best for cities with topic pages. For best results, use topic search."
    );
  });

  bot.command("summarise", async (ctx) => {
    const lookbackResult = extractLookback(ctx.message?.text);

    if (typeof lookbackResult === "object" && "error" in lookbackResult) {
      await ctx.reply(
        `❌ ${lookbackResult.error}\n\nUsage: /summarise 60`
      );
      return;
    }

    const lookbackMinutes = lookbackResult;
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.reply("❌ Could not determine chat id.");
      return;
    }

    const token = `${chatId}:${Date.now()}:${crypto.randomUUID()}`;

    const callbackParam = encodeURIComponent(token);
    const url = new URL("/pay", options.baseUrl);
    url.searchParams.set("source", "telegram");
    url.searchParams.set("telegram_callback", callbackParam);
    url.searchParams.set("chatId", String(chatId));
    url.searchParams.set("lookbackMinutes", String(lookbackMinutes));

    const keyboard = new InlineKeyboard().url(
      "Pay $0.05 via x402",
      url.toString()
    );

    const paymentMessage = await ctx.reply(
      `🪙 *Payment Required*\n\n` +
        `We'll summarise the last ${lookbackMinutes} minutes of this chat.`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );

    pendingTelegramCallbacks.set(token, {
      chatId,
      threadId: "message_thread_id" in ctx.message ? ctx.message.message_thread_id : undefined,
      messageId: ctx.message?.message_id,
      username: ctx.from?.username,
      lookbackMinutes,
      paymentMessageId: paymentMessage.message_id,
      expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
    });
  });

  function parseSearchEventsCommand(text: string | undefined): 
    | { query: string; searchType: "place" | "topic" } 
    | { error: string } {
    if (!text) {
      return { error: "Usage: /search_events in <place> or /search_events on <topic>" };
    }

    const trimmed = text.trim();
    const parts = trimmed.split(/\s+/);

    // Check for /search_events command
    if (parts.length < 3) {
      return { error: "Usage: /search_events in <place> or /search_events on <topic>" };
    }

    // Find "in" or "on" keyword
    let searchType: "place" | "topic" | null = null;
    let queryStartIndex = -1;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].toLowerCase();
      if (part === "in") {
        searchType = "place";
        queryStartIndex = i + 1;
        break;
      } else if (part === "on") {
        searchType = "topic";
        queryStartIndex = i + 1;
        break;
      }
    }

    if (!searchType || queryStartIndex === -1 || queryStartIndex >= parts.length) {
      return { error: "Usage: /search_events in <place> or /search_events on <topic>" };
    }

    const query = parts.slice(queryStartIndex).join(" ").trim();

    if (!query) {
      return { error: "Please provide a search query. Usage: /search_events in <place> or /search_events on <topic>" };
    }

    return { query, searchType };
  }

  bot.command("search_events", async (ctx) => {
    const parseResult = parseSearchEventsCommand(ctx.message?.text);

    if ("error" in parseResult) {
      await ctx.reply(
        `❌ ${parseResult.error}\n\n` +
        `Examples:\n` +
        `• /search_events on crypto\n` +
        `• /search_events on AI\n` +
        `• /search_events in San Francisco (limited support)`
      );
      return;
    }

    const { query, searchType } = parseResult;
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.reply("❌ Could not determine chat id.");
      return;
    }

    const token = `${chatId}:${Date.now()}:${crypto.randomUUID()}`;

    const callbackParam = encodeURIComponent(token);
    const url = new URL("/pay", options.baseUrl);
    url.searchParams.set("source", "telegram");
    url.searchParams.set("telegram_callback", callbackParam);
    url.searchParams.set("chatId", String(chatId));
    url.searchParams.set("query", query);
    url.searchParams.set("searchType", searchType);

    const keyboard = new InlineKeyboard().url(
      "Pay $0.05 via x402",
      url.toString()
    );

    const searchTypeLabel = searchType === "place" ? "location" : "topic";
    const paymentMessage = await ctx.reply(
      `🪙 *Payment Required*\n\n` +
        `Searching for events by ${searchTypeLabel}: *${query}*`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );

    pendingTelegramCallbacks.set(token, {
      chatId,
      threadId: "message_thread_id" in ctx.message ? ctx.message.message_thread_id : undefined,
      messageId: ctx.message?.message_id,
      username: ctx.from?.username,
      query,
      searchType,
      paymentMessageId: paymentMessage.message_id,
      expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
    });
  });

  return bot;
}

