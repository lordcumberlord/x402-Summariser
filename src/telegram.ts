import { Bot, Context, session, SessionFlavor, InlineKeyboard } from "grammy";
import { validateLookback, MAX_LOOKBACK_MINUTES } from "./lookback";
import { PAYMENT_CALLBACK_EXPIRY_MS } from "./constants";
import { pendingTelegramCallbacks } from "./pending";

type MyContext = Context & SessionFlavor<SessionData>;

type SessionData = {
  mode?: "awaiting_lookback";
  pendingLookback?: number;
};

function summarisePrompt() {
  return (
    "Send me how many minutes you want summarised, like 60 or 240. " +
    `Maximum is ${MAX_LOOKBACK_MINUTES} minutes.`
  );
}

function payUrl(baseUrl: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return `${baseUrl}/pay?${search.toString()}`;
}

export function createTelegramBot(options: {
  token: string;
  baseUrl: string;
}) {
  const bot = new Bot<MyContext>(options.token);

  bot.catch((err) => {
    console.error("[telegram] polling error", err.error ?? err);
  });

  bot.use(
    session({
      initial(): SessionData {
        return {};
      },
    })
  );

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hey! I'm the x402 Summariser Bot for Telegram. " +
        "Use /summarise to get a recap of this chat."
    );
  });

  bot.command("summarise", async (ctx) => {
    ctx.session.mode = "awaiting_lookback";
    await ctx.reply(summarisePrompt());
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.session.mode !== "awaiting_lookback") {
      return;
    }

    const lookbackValidation = validateLookback(ctx.message.text);
    if ("error" in lookbackValidation) {
      await ctx.reply(`❌ ${lookbackValidation.error}\n\n${summarisePrompt()}`);
      return;
    }

    const chat = ctx.chat;
    const message = ctx.message;
    const lookbackMinutes = lookbackValidation.minutes;

    ctx.session.mode = undefined;

    const token = `${chat.id}:${message.message_id}:${Date.now()}:${crypto.randomUUID()}`;
    pendingTelegramCallbacks.set(token, {
      chatId: chat.id,
      threadId: "message_thread_id" in message ? message.message_thread_id : undefined,
      messageId: message.message_id,
      username: ctx.from?.username,
      lookbackMinutes,
      expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
    });

    const callbackParam = encodeURIComponent(token);
    const url = payUrl(options.baseUrl, {
      source: "telegram",
      telegram_callback: callbackParam,
      chatId: chat.id,
      lookbackMinutes,
    });

    const keyboard = new InlineKeyboard().url("Pay $0.10 via x402", url);

    await ctx.reply(
      `💳 *Payment Required*\n\n` +
        `We’ll summarise the last ${lookbackMinutes} minutes of this chat.\n\n` +
        `Tap the button below to pay $0.10 via x402. Once payment clears, the summary will appear here automatically.`,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );
  });

  return bot;
}

