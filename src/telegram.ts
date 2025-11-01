import { Bot, InlineKeyboard } from "grammy";
import { validateLookback } from "./lookback";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import { pendingTelegramCallbacks } from "./pending";
import { addTelegramMessage } from "./telegramStore";

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
    if (chatId && text.trim().length > 0) {
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

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hey! I'm the x402 Summariser Bot. Use /summarise <minutes> to get a recap."
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
      "Pay $0.10 via x402",
      url.toString()
    );

    const paymentMessage = await ctx.reply(
      `💳 *Payment Required*\n\n` +
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

  return bot;
}

