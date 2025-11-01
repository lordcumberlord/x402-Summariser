import { z } from "zod";
import {
  createAgentApp,
  createAxLLMClient,
  AgentKitConfig,
} from "@lucid-dreams/agent-kit";
import { flow } from "@ax-llm/ax";
import { getTelegramMessagesWithin } from "./telegramStore";

type DiscordAuthor = {
  id: string;
  username?: string;
  global_name?: string;
  display_name?: string;
};

type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string | null;
  url: string;
};

type DiscordReaction = {
  emoji: {
    id?: string | null;
    name: string;
    animated?: boolean;
  };
  count: number;
  me?: boolean;
};

type DiscordMessage = {
  id: string;
  content: string;
  timestamp: string;
  author?: DiscordAuthor;
  attachments?: DiscordAttachment[];
  reactions?: DiscordReaction[];
};

type ConversationEntry = {
  speaker: string;
  content: string;
};

type DiscordChannelInfo = {
  id: string;
  name?: string;
  guild_id?: string;
};

type DiscordGuildInfo = {
  id: string;
  name?: string;
};

type DiscordMessageLinkParts = {
  guildId: string | null;
  channelId: string;
  messageId: string;
};

type SummarizerAttachment = {
  url: string;
  filename?: string | null;
  content_type?: string | null;
  caption?: string | null;
};

type SummarizerReaction = {
  emoji: string | null;
  count: number;
};

type SummarizerMessage = {
  id: string;
  timestamp: string;
  author: string;
  is_admin: boolean;
  is_bot: boolean;
  text: string;
  attachments: SummarizerAttachment[];
  reactions: SummarizerReaction[];
  reply_to_id?: string;
  thread_id?: string;
  event_type?: string;
};

const DISCORD_API_DEFAULT_BASE = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n;
const MAX_FETCH_PAGES = 10; // safeguards agent costs by limiting to 1,000 messages.

// USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const configOverrides: AgentKitConfig = {
  payments: {
    facilitatorUrl:
      (process.env.FACILITATOR_URL as any) ??
      "https://facilitator.x402.rs",
    payTo:
      (process.env.PAY_TO as `0x${string}`) ??
      "0xb308ed39d67D0d4BAe5BC2FAEF60c66BBb6AE429",
    network: (process.env.NETWORK as any) ?? "base",
    defaultPrice: process.env.DEFAULT_PRICE ?? "0.1",
    // Add token configuration for USDC
    // Note: x402 may require token address in payment headers, not config
    // This will depend on x402 SDK implementation
  },
};

const axClient = createAxLLMClient({
  logger: {
    warn(message, error) {
      if (error) {
        console.warn(`[discord-summary-agent] ${message}`, error);
      } else {
        console.warn(`[discord-summary-agent] ${message}`);
      }
    },
  },
  provider:
    process.env.AX_PROVIDER ?? process.env.AXLLM_PROVIDER ?? process.env.OPENAI_PROVIDER ?? undefined,
  model:
    process.env.AX_MODEL ?? process.env.AXLLM_MODEL ?? process.env.OPENAI_MODEL ?? undefined,
  apiKey:
    process.env.AX_API_KEY ?? process.env.AXLLM_API_KEY ?? process.env.OPENAI_API_KEY ?? undefined,
  x402: {
    ai: {
      apiURL:
        process.env.AX_API_URL ??
        process.env.AXLLM_API_URL ??
        process.env.OPENAI_API_URL ??
        undefined,
    },
  },
});

if (!axClient.isConfigured()) {
  console.warn(
    "[discord-summary-agent] Ax LLM provider not configured — defaulting to scripted fallbacks."
  );
}

const structuredSummarizerPrompt = `You are a chat summarizer for Discord and Telegram.

Generate a friendly, concise Markdown summary of the provided messages.

🔹 OUTPUT FORMAT

Greeting + Context

Time-aware greeting:
• 04:00–11:59 → "Good morning!"
• 12:00–17:59 → "Good afternoon!"
• 18:00–03:59 → "Good evening!"

Follow with:
Here's a summary of what happened in the last {window_minutes} minutes:

Highlights

Summarize notable discussions, jokes, or updates using natural sentences.
Use bullets or short paragraphs as needed.
Include all meaningful, non-redundant moments within max_chars; no fixed limit.
Blend informational and social content smoothly.
Phrase humor naturally ("joked about…", "light banter around…").
Avoid raw tone labels or mechanical wording.

Action Items

After writing the Highlights, scan through what you wrote and identify any tasks, assignments, or next steps mentioned.

If at least one task exists:
1. Keep the task mentioned in the Highlights (it provides context about who assigned it and when).
2. Extract and list it again in a separate Action Items section below.

Create the Action Items section with this exact format:

**Action Items:**
• @User to <action> by <date or timeframe>.
• @User to <action> as discussed.

CRITICAL FORMATTING REQUIREMENTS:
- Action Items section must start on a new line after a blank line.
- The header **Action Items:** must be bolded and exactly as shown (with colon).
- Each task must be on its own line with a bullet (•).
- Extract the task in the simplified format: "@User to <action> by <date>."
- If there are no tasks at all, omit this entire section.

Example: If highlights say "Cumberlord assigned Bulbhead the task of reporting the death toll by Monday", extract it as "• @Bulbhead to report the death toll by Monday."

No Mood Line

Do not include a mood or tone summary line.
Tone should be conveyed naturally through phrasing.

🔹 SUMMARIZATION LOGIC

Filter noise – ignore stickers, emoji-only posts, "+1/lol", bot logs, join/leave notices, duplicates.

Group threads – cluster by replies or thread IDs.

Score content
• Importance: +3 decision/task · +2 resolution/result · +1 idea/guidance.
• Engagement: +3 ≥ 5 reactions or ≥ 3 replies · +2 humor/irony · +1 meme/teasing.

Select highlights – include all meaningful or engaging items until near max_chars; merge duplicates.

Tone & phrasing – write in plain, friendly English; interpret lightly rather than mechanically.

Quiet condition – only output
_Quiet hour — no notable updates or chatter._
if fewer than 3 messages, no replies, no reactions, and no humor detected.

🔹 EXAMPLE (fictional)

Good evening! Here's a summary of what happened in the last 120 minutes:

• @Orion joked about sending pizza deliveries to Mars, sparking light banter about space logistics.

• @Orion assigned @Lyra the task of confirming the venue booking by Monday.

• The team also discussed preparations for next week's event and assigned follow-ups.



**Action Items:**

• @Lyra to confirm venue booking by Monday.

• @Milo to finalize the attendee list by tomorrow.
`;

const structuredSummarizerSignature =
  "platform:string, window:string, maxChars:number, payload:string -> summary:string";
const structuredSummarizerNodeSpec = `${structuredSummarizerSignature} ${JSON.stringify(
  structuredSummarizerPrompt
)}`;

const structuredSummaryFlow = flow<{
  platform: string;
  window: string;
  maxChars: number;
  payload: string;
}>()
  .node("summarizer", structuredSummarizerNodeSpec)
  .execute("summarizer", (state) => ({
    platform: state.platform,
    window: state.window,
    maxChars: state.maxChars,
    payload: state.payload,
  }))
  .returns((state) => ({
    summary: state.summarizerResult.summary as string,
  }));

const { app, addEntrypoint } = createAgentApp(
  {
    name: "discord-summary-agent",
    version: "0.1.0",
    description:
      "Summarises Discord channel conversations over a time window and surfaces actionable next steps.",
  },
  {
    config: configOverrides,
  }
);

addEntrypoint({
  key: "summarise chat",
  description:
    "Summarise a Discord channel for the most recent lookback window and extract action items.",
  input: z
    .object({
      channelId: z
        .string()
        .min(1, { message: "Provide the Discord channel ID." })
        .describe("Discord channel ID to summarise.")
        .optional(),
      serverId: z
        .string()
        .min(1, { message: "Provide the Discord server (guild) ID." })
        .describe("Discord server (guild) ID that owns the channel.")
        .optional(),
      lookbackMinutes: z
        .coerce.number()
        .int({ message: "Lookback minutes must be a whole number." })
        .min(1, { message: "Lookback window must be at least 1 minute." })
        .max(1440 * 14, {
          message: "Lookback window is capped at 14 days (20,160 minutes).",
        })
        .describe(
          "Number of minutes prior to now to include in the summary window."
        )
        .optional(),
      startMessageUrl: z
        .string()
        .url({ message: "Provide a valid Discord message link URL." })
        .describe(
          "Discord message link marking the first message to include (inclusive)."
        )
        .optional(),
      endMessageUrl: z
        .string()
        .url({ message: "Provide a valid Discord message link URL." })
        .describe(
          "Discord message link marking the last message to include (inclusive)."
        )
        .optional(),
    })
    .superRefine((value, ctx) => {
      const hasLookback = typeof value.lookbackMinutes === "number";
      const hasStartLink = Boolean(value.startMessageUrl);
      const hasEndLink = Boolean(value.endMessageUrl);

      if (hasLookback && (hasStartLink || hasEndLink)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide either a lookback window or message links, not both.",
          path: ["lookbackMinutes"],
        });
      }

      if (hasStartLink !== hasEndLink) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Provide both start and end message links when using message link summarisation.",
          path: hasStartLink ? ["endMessageUrl"] : ["startMessageUrl"],
        });
      }

      if (!hasLookback && !(hasStartLink && hasEndLink)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Provide a lookback window in minutes or both start and end message links.",
        });
      }

      if (hasLookback && !value.channelId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Channel ID is required when summarising via a lookback window.",
          path: ["channelId"],
        });
      }
    }),
  price: process.env.ENTRYPOINT_PRICE || "0.10", // Default to 0.10 USDC (or set via ENTRYPOINT_PRICE env var)
  // Note: x402 will handle token selection based on payment headers
  // For USDC, users will pay with USDC when using x402 wallet
  output: z.object({
    summary: z.string(),
    actionables: z.array(z.string()),
  }),
  async handler(ctx) {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "Missing DISCORD_BOT_TOKEN. Provide a Discord bot token in the environment."
      );
    }

    const baseUrl =
      process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;

    const now = new Date();
    const lookbackMinutes =
      typeof ctx.input.lookbackMinutes === "number"
        ? ctx.input.lookbackMinutes
        : undefined;
    const startMessageUrl = ctx.input.startMessageUrl;
    const endMessageUrl = ctx.input.endMessageUrl;

    const usingLookback = typeof lookbackMinutes === "number";
    const usingMessageLinks = Boolean(startMessageUrl && endMessageUrl);

    let start: Date;
    let end: Date;
    let initialAfterSnowflake: string;
    let endMessageId: string | undefined;
    let channelId: string;
    let guildId: string | null = ctx.input.serverId?.trim() ?? null;
    let rangeLabel: string;

    if (usingLookback) {
      const minutes = lookbackMinutes as number;
      channelId = (ctx.input.channelId ?? "").trim();
      const lookbackMs = minutes * 60 * 1000;
      start = new Date(now.getTime() - lookbackMs);
      const discordEpochDate = new Date(Number(DISCORD_EPOCH));
      if (start < discordEpochDate) {
        start = discordEpochDate;
      }
      end = now;
      initialAfterSnowflake = snowflakeFromDate(start, -1n);
      rangeLabel = `the last ${minutes} minutes`;
    } else if (usingMessageLinks) {
      const startLink = parseDiscordMessageUrl(startMessageUrl as string);
      const endLink = parseDiscordMessageUrl(endMessageUrl as string);
      if (!startLink || !endLink) {
        throw new Error("Unable to parse one or both Discord message links.");
      }

      if (startLink.channelId !== endLink.channelId) {
        throw new Error(
          "Start and end message links must reference the same channel."
        );
      }

      if (
        ctx.input.channelId &&
        ctx.input.channelId.trim() !== startLink.channelId
      ) {
        throw new Error(
          "Provided channel ID does not match the supplied message links."
        );
      }

      channelId = startLink.channelId;
      const startMessageId = startLink.messageId;
      const endMessageIdResolved = endLink.messageId;

      if (compareSnowflakes(startMessageId, endMessageIdResolved) > 0) {
        throw new Error(
          "Start message link must precede (or equal) the end message link."
        );
      }

      initialAfterSnowflake = decrementSnowflake(startMessageId);
      endMessageId = endMessageIdResolved;

      start = discordSnowflakeToDate(startMessageId);
      const endDate = discordSnowflakeToDate(endMessageIdResolved);
      end = new Date(endDate.getTime() + 1000);

      guildId =
        guildId ?? startLink.guildId ?? endLink.guildId ?? null;

      rangeLabel = `message links ${startMessageUrl} → ${endMessageUrl}`;
    } else {
      throw new Error(
        "Provide a lookback window or both start and end message links."
      );
    }

    const channelMeta = await fetchChannelInfo({
      token,
      baseUrl,
      channelId,
    });

    guildId = guildId ?? channelMeta?.guild_id ?? null;

    const guildMeta = guildId
      ? await fetchGuildInfo({ token, baseUrl, guildId })
      : null;

    const channelLabelParts = [
      guildMeta?.name ?? (guildId ? `server ${guildId}` : "unknown server"),
      channelMeta?.name ? `#${channelMeta.name}` : `channel ${channelId}`,
    ];
    const channelLabel = channelLabelParts.join(" · ");

    const messages = await fetchMessagesBetween({
      token,
      baseUrl,
      channelId,
      start,
      end,
      initialAfterSnowflake,
      endMessageId,
    });

    if (!messages.length) {
      return {
        output: {
          summary: `No Discord messages found in ${channelLabel} for ${rangeLabel}.`,
          actionables: [],
        },
        model: "discord-empty",
      };
    }

    // Log first few messages to debug content extraction
    console.log(`[discord-summary-agent] Fetched ${messages.length} messages`);
    if (messages.length > 0) {
      console.log(`[discord-summary-agent] First message sample:`, {
        id: messages[0].id,
        content: messages[0].content,
        contentLength: messages[0].content?.length || 0,
        hasAuthor: !!messages[0].author,
        author: messages[0].author?.username || messages[0].author?.global_name,
      });
    }

    const conversation = formatConversation(messages);
    const conversationEntries = extractConversationEntries(conversation);
    console.log(`[discord-summary-agent] Formatted conversation preview (first 500 chars):`, conversation.substring(0, 500));
    
    const timeWindow = `${start.toISOString()} → ${end.toISOString()} (${rangeLabel})`;

    const llm = axClient.ax;
    if (!llm) {
      const fallbackSummary = conversation
        .split("\n")
        .slice(0, 5)
        .join("\n")
        .trim();

      const fallbackText =
        fallbackSummary ||
        `Messages retrieved (${rangeLabel}), but AxFlow is not configured to generate a summary.`;

      return {
        output: {
          summary: finalizeSummary(
            fallbackText,
            lookbackMinutes,
            rangeLabel,
            conversationEntries
          ),
          actionables: [],
        },
        model: "axllm-fallback",
      };
    }

    try {
      const result = await structuredSummaryFlow.forward(llm, {
        platform: "discord",
        window: timeWindow,
        maxChars: 1000, // Example max chars, adjust as needed
        payload: JSON.stringify({
          platform: "discord",
          window: timeWindow,
          max_chars: 1000,
          messages: messages.map((msg) => ({
            id: msg.id,
            timestamp: msg.timestamp,
            author: msg.author,
            is_admin: false, // Placeholder, needs actual Discord API data
            is_bot: false, // Placeholder, needs actual Discord API data
            text: msg.content,
            attachments: msg.attachments,
            reactions: msg.reactions,
            reply_to_id: msg.reply_to_id,
            thread_id: msg.thread_id,
            event_type: "message", // Placeholder, needs actual Discord API data
          })),
        }),
      });

      const usageEntry = structuredSummaryFlow.getUsage().at(-1);
      structuredSummaryFlow.resetUsage();

      // Clean up summary: remove timestamps and payment-related content
      let summary = result.summary ?? "";
      
      // Remove timestamps in various formats
      summary = summary
        .replace(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/g, "") // ISO timestamps
        .replace(/\[[^\]]*\d{4}[^\]]*\]/g, "") // Any bracketed timestamps
        .replace(/x402 Summariser[^\n]*\n?/gi, "") // Remove "x402 Summariser:" prefix
        .trim();

      summary = finalizeSummary(
        summary,
        lookbackMinutes,
        rangeLabel,
        conversationEntries
      );

      return {
        output: {
          summary: summary || "Summary generated successfully.",
          actionables: [],
        },
        model: usageEntry?.model,
      };
    } catch (error: any) {
      const errorDetails: Record<string, unknown> = {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
      };

      if (error?.response) {
        errorDetails.responseStatus = error.response.status;
        errorDetails.responseData = error.response?.data;
        errorDetails.responseHeaders = error.response?.headers;
      }

      if (error?.cause) {
        errorDetails.cause = error.cause;
      }

      console.error("[discord-summary-agent] LLM flow error:", errorDetails);
      structuredSummaryFlow.resetUsage();

      const fallbackSummary = conversation
        .split("\n")
        .slice(0, 5)
        .join("\n")
        .trim();

      const fallbackText =
        fallbackSummary ||
        `Messages retrieved (${rangeLabel}), but failed to generate AI summary: ${error?.message || String(error)}`;

      return {
        output: {
          summary: finalizeSummary(
            fallbackText,
            lookbackMinutes,
            rangeLabel,
            conversationEntries
          ),
          actionables: [],
        },
        model: "axllm-fallback",
      };
    }
  },
});

addEntrypoint({
  key: "summarise telegram chat",
  description:
    "Summarise a Telegram chat by providing the chat ID and lookback window.",
  input: z
    .object({
      chatId: z
        .string()
        .min(1, { message: "Provide the Telegram chat ID." })
        .describe("Telegram chat ID to summarise."),
      lookbackMinutes: z
        .coerce.number()
        .int({ message: "Lookback minutes must be a whole number." })
        .min(1, { message: "Lookback window must be at least 1 minute." })
        .max(1440 * 14, {
          message: "Lookback window is capped at 14 days (20,160 minutes).",
        })
        .describe(
          "Number of minutes prior to now to include in the summary window."
        )
        .optional(),
    })
    .superRefine((value, ctx) => {
      if (!value.chatId.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide a valid Telegram chat ID.",
          path: ["chatId"],
        });
      }
    }),
  price: process.env.ENTRYPOINT_PRICE || "0.10",
  output: z.object({
    summary: z.string(),
    actionables: z.array(z.string()),
  }),
  async handler(ctx) {
    const chatIdRaw = ctx.input.chatId.trim();
    const chatNumeric = Number(chatIdRaw);
    if (!Number.isFinite(chatNumeric)) {
      throw new Error("Invalid Telegram chat ID provided.");
    }

    const lookbackMinutes =
      typeof ctx.input.lookbackMinutes === "number"
        ? ctx.input.lookbackMinutes
        : 60;

    const messages = getTelegramMessagesWithin(chatNumeric, lookbackMinutes);
    const meaningfulMessages = messages.filter((msg) => {
      const trimmed = msg.text?.trim();
      return trimmed && !trimmed.startsWith("/");
    });
    if (meaningfulMessages.length < 3) {
      if (meaningfulMessages.length > 0) {
        return {
          output: {
            summary: buildSocialFallbackSummaryFromTelegram(meaningfulMessages),
            actionables: [],
          },
          model: "telegram-social-fallback",
        };
      }
      return {
        output: {
          summary: `No material updates or chatter in this window.`,
          actionables: [],
        },
        model: "telegram-insufficient",
      };
    }

    const summarizerMessages = buildTelegramSummarizerMessages(meaningfulMessages);
    const windowLabel = `last ${lookbackMinutes} minutes`;
    const maxChars = 1100;
    const payload = buildSummarizerPayload(
      "telegram",
      windowLabel,
      maxChars,
      summarizerMessages
    );

    const llm = axClient.ax;
    if (!llm) {
      return {
        output: {
          summary: buildSocialFallbackSummaryFromTelegram(meaningfulMessages),
          actionables: [],
        },
        model: "telegram-fallback",
      };
    }

    try {
      const result = await structuredSummaryFlow.forward(llm, {
        platform: "telegram",
        window: windowLabel,
        maxChars,
        payload,
      });

      const summary = (result.summary ?? "").trim();
      let finalSummary = summary;
      if (/quiet hour/i.test(finalSummary)) {
        finalSummary = buildSocialFallbackSummaryFromTelegram(meaningfulMessages);
      }
      if (!finalSummary) {
        return {
          output: {
            summary: buildSocialFallbackSummaryFromTelegram(meaningfulMessages),
            actionables: [],
          },
          model: "telegram-social-fallback",
        };
      }
      return {
        output: {
          summary: finalSummary,
          actionables: [],
        },
        model: "structured-summary",
      };
    } catch (error: any) {
      console.error("[telegram-summary-agent] LLM flow error:", error);
      return {
        output: {
          summary: buildSocialFallbackSummaryFromTelegram(meaningfulMessages),
          actionables: [],
        },
        model: "telegram-error",
      };
    }
  },
});

export { app };

// Export handler logic for use in Discord interactions
export async function executeSummariseChat(input: {
  channelId?: string;
  serverId?: string;
  lookbackMinutes?: number;
  startMessageUrl?: string;
  endMessageUrl?: string;
}) {
  // This is a simplified version that can be called from Discord interactions
  // It reuses the same logic as the entrypoint handler
  const ctx = {
    input,
  } as any;
  
  // Call the actual handler - we need to access it
  // For now, we'll need to extract the logic
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "Missing DISCORD_BOT_TOKEN. Provide a Discord bot token in the environment."
    );
  }

  const baseUrl =
    process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;

  const now = new Date();
  const lookbackMinutes =
    typeof input.lookbackMinutes === "number"
      ? input.lookbackMinutes
      : undefined;
  const startMessageUrl = input.startMessageUrl;
  const endMessageUrl = input.endMessageUrl;

  const usingLookback = typeof lookbackMinutes === "number";
  const usingMessageLinks = Boolean(startMessageUrl && endMessageUrl);

  let start: Date;
  let end: Date;
  let initialAfterSnowflake: string;
  let endMessageId: string | undefined;
  let channelId: string;
  let guildId: string | null = input.serverId?.trim() ?? null;
  let rangeLabel: string;

  if (usingLookback) {
    const minutes = lookbackMinutes as number;
    channelId = (input.channelId ?? "").trim();
    const lookbackMs = minutes * 60 * 1000;
    start = new Date(now.getTime() - lookbackMs);
    const discordEpochDate = new Date(Number(DISCORD_EPOCH));
    if (start < discordEpochDate) {
      start = discordEpochDate;
    }
    end = now;
    initialAfterSnowflake = snowflakeFromDate(start, -1n);
    rangeLabel = `the last ${minutes} minutes`;
  } else if (usingMessageLinks) {
    const startLink = parseDiscordMessageUrl(startMessageUrl as string);
    const endLink = parseDiscordMessageUrl(endMessageUrl as string);
    if (!startLink || !endLink) {
      throw new Error("Unable to parse one or both Discord message links.");
    }

    if (startLink.channelId !== endLink.channelId) {
      throw new Error(
        "Start and end message links must reference the same channel."
      );
    }

    if (
      input.channelId &&
      input.channelId.trim() !== startLink.channelId
    ) {
      throw new Error(
        "Provided channel ID does not match the supplied message links."
      );
    }

    channelId = startLink.channelId;
    const startMessageId = startLink.messageId;
    const endMessageIdResolved = endLink.messageId;

    if (compareSnowflakes(startMessageId, endMessageIdResolved) > 0) {
      throw new Error(
        "Start message link must precede (or equal) the end message link."
      );
    }

    initialAfterSnowflake = decrementSnowflake(startMessageId);
    endMessageId = endMessageIdResolved;

    start = discordSnowflakeToDate(startMessageId);
    const endDate = discordSnowflakeToDate(endMessageIdResolved);
    end = new Date(endDate.getTime() + 1000);

    guildId =
      guildId ?? startLink.guildId ?? endLink.guildId ?? null;

    rangeLabel = `message links ${startMessageUrl} → ${endMessageUrl}`;
  } else {
    throw new Error(
      "Provide a lookback window or both start and end message links."
    );
  }

  const channelMeta = await fetchChannelInfo({
    token,
    baseUrl,
    channelId,
  });

  guildId = guildId ?? channelMeta?.guild_id ?? null;

  const guildMeta = guildId
    ? await fetchGuildInfo({ token, baseUrl, guildId })
    : null;

  const channelLabelParts = [
    guildMeta?.name ?? (guildId ? `server ${guildId}` : "unknown server"),
    channelMeta?.name ? `#${channelMeta.name}` : `channel ${channelId}`,
  ];
  const channelLabel = channelLabelParts.join(" · ");

  const messages = await fetchMessagesBetween({
    token,
    baseUrl,
    channelId,
    start,
    end,
    initialAfterSnowflake,
    endMessageId,
  });

  if (!messages.length) {
    return {
      summary: `No Discord messages found in ${channelLabel} for ${rangeLabel}.`,
      actionables: [],
    };
  }

  const conversation = formatConversation(messages);
  const conversationEntries = extractConversationEntries(conversation);
  const timeWindow = `${start.toISOString()} → ${end.toISOString()} (${rangeLabel})`;
  const windowLabel = rangeLabel.startsWith("the ")
    ? rangeLabel.replace(/^the\s+/i, "")
    : rangeLabel;

  const llm = axClient.ax;
  if (!llm) {
    if (shouldForceSocialDiscord(messages)) {
      return {
        summary: buildSocialFallbackSummaryFromDiscord(messages),
        actionables: [],
      };
    }
    const fallbackSummary = conversation
      .split("\n")
      .slice(0, 5)
      .join("\n")
      .trim();

    const fallbackText = fallbackSummary || `No material updates or chatter in this window.`;

    return {
      summary: finalizeSummary(
        fallbackText,
        lookbackMinutes,
        rangeLabel,
        conversationEntries
      ),
      actionables: [],
    };
  }

  const summarizerMessages = buildDiscordSummarizerMessages(messages, guildMeta);
  const maxChars = 1200;
  const payload = buildSummarizerPayload(
    "discord",
    windowLabel,
    maxChars,
    summarizerMessages
  );

  try {
    const result = await structuredSummaryFlow.forward(llm, {
      platform: "discord",
      window: windowLabel,
      maxChars,
      payload,
    });

    const summary = (result.summary ?? "").trim();
    let finalSummary = summary;
    if (/quiet hour/i.test(finalSummary) && shouldForceSocialDiscord(messages)) {
      finalSummary = buildSocialFallbackSummaryFromDiscord(messages);
    }
    if (!finalSummary) {
      if (shouldForceSocialDiscord(messages)) {
        return {
          summary: buildSocialFallbackSummaryFromDiscord(messages),
          actionables: [],
        };
      }
      return {
        summary: `No material updates or chatter in this window.`,
        actionables: [],
      };
    }

    const trimmedSummary = finalSummary.length > 1800
      ? finalSummary.slice(0, 1795).trimEnd() + " …"
      : finalSummary;

    return {
      summary: trimmedSummary,
      actionables: [],
    };
  } catch (error: any) {
    console.error("[discord-summary-agent] LLM flow error:", error);
    if (shouldForceSocialDiscord(messages)) {
      return {
        summary: buildSocialFallbackSummaryFromDiscord(messages),
        actionables: [],
      };
    }
    const fallbackSummary = conversation
      .split("\n")
      .slice(0, 5)
      .join("\n")
      .trim();

    const fallbackText =
      fallbackSummary || `No material updates or chatter in this window.`;

    return {
      summary: finalizeSummary(
        fallbackText,
        lookbackMinutes,
        rangeLabel,
        conversationEntries
      ),
      actionables: [],
    };
  }
}

function formatConversation(messages: DiscordMessage[]): string {
  const sorted = [...messages].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return sorted
    .map((message) => {
      const author =
        message.author?.global_name ||
        message.author?.display_name ||
        message.author?.username ||
        "Unknown user";

      const attachmentNotes =
        message.attachments && message.attachments.length
          ? message.attachments
              .map(
                (attachment) =>
                  `[attachment: ${attachment.filename}${
                    attachment.content_type ? `, ${attachment.content_type}` : ""
                  }]`
              )
              .join(" ")
          : "";

      // Format reactions if present (e.g., "😀 x5, 👍 x3")
      const reactionNotes =
        message.reactions && message.reactions.length > 0
          ? message.reactions
              .map((r) => {
                const emoji = r.emoji.id 
                  ? `<:${r.emoji.name}:${r.emoji.id}>`
                  : r.emoji.name;
                return `${emoji} x${r.count}`;
              })
              .join(", ")
          : "";

      const content = [message.content, attachmentNotes, reactionNotes]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      return `${author}: ${content || "(no text content)"}`;
    })
    .join("\n");
}

function extractConversationEntries(conversation: string): ConversationEntry[] {
  return conversation
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) {
        return { speaker: "Unknown", content: line };
      }
      const speaker = line.slice(0, idx).trim();
      const content = line.slice(idx + 1).trim();
      return { speaker, content };
    });
}

function ensureGreeting(
  summary: string,
  lookbackMinutes?: number,
  rangeLabel?: string,
  now: Date = new Date()
): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return trimmed;
  }

  const greetingRegex = /^(good\s+(morning|afternoon|evening|night)|hello|hi|hey|greetings)/i;
  if (greetingRegex.test(trimmed)) {
    return trimmed;
  }

  const greeting = timeBasedGreeting(now);

  let windowPhrase: string;
  if (typeof lookbackMinutes === "number" && lookbackMinutes > 0) {
    windowPhrase = `the last ${lookbackMinutes} minutes`;
  } else if (rangeLabel && rangeLabel.trim().length > 0) {
    windowPhrase = rangeLabel.trim();
  } else {
    windowPhrase = "this period";
  }

  const intro = `${greeting} Here is what happened in ${windowPhrase}:`;

  if (trimmed.startsWith("•") || trimmed.startsWith("-")) {
    return `${intro}\n${trimmed}`;
  }

  return `${intro} ${trimmed}`.trim();
}

function timeBasedGreeting(now: Date): string {
  const hour = now.getHours();

  if (hour >= 5 && hour < 12) {
    return "Good morning!";
  }

  if (hour >= 12 && hour < 17) {
    return "Good afternoon!";
  }

  if (hour >= 17 && hour < 22) {
    return "Good evening!";
  }

  return "Hello!";
}

function finalizeSummary(
  rawSummary: string,
  lookbackMinutes?: number,
  rangeLabel?: string,
  conversationEntries: ConversationEntry[] = []
): string {
  const withGreeting = ensureGreeting(rawSummary, lookbackMinutes, rangeLabel);
  return normalizeSummaryBullets(withGreeting, conversationEntries);
}

function normalizeSummaryBullets(
  summary: string,
  conversationEntries: ConversationEntry[]
): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return trimmed;
  }

  const speakerSet = new Set(
    conversationEntries.map((entry) => normalizeName(entry.speaker))
  );

  const rawLines = trimmed.split(/\n+/);
  let introLine = rawLines[0].trim();
  let bodyText = rawLines.slice(1).join("\n").trim();

  const introColonIndex = introLine.indexOf(":");
  if (introColonIndex !== -1) {
    const introPrefix = introLine.slice(0, introColonIndex + 1).trim();
    const introSuffix = introLine.slice(introColonIndex + 1).trim();
    introLine = introPrefix;
    if (introSuffix) {
      bodyText = bodyText ? introSuffix + "\n" + bodyText : introSuffix;
    }
  }

  if (!bodyText) {
    return introLine;
  }

  const bulletSources = bodyText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const bullets = bulletSources
    .map((line) => transformLineToBullet(line, conversationEntries, speakerSet))
    .filter(Boolean);

  const filteredBullets = filterAndRankBullets(bullets);

  if (!filteredBullets.length) {
    return (introLine + "\n" + bodyText).trim();
  }

  const expandedBullets: string[] = [];
  for (const bullet of filteredBullets) {
    if (bullet.includes(" • ")) {
      const parts = bullet
        .split(/\s*•\s*/)
        .map((part) => part.trim())
        .filter(Boolean);
      expandedBullets.push(...parts);
    } else {
      expandedBullets.push(bullet);
    }
  }

  const lines = expandedBullets.map((line) => (line.startsWith("•") ? line : "• " + line));

  return introLine + "\n" + lines.join("\n");
}

function transformLineToBullet(
  line: string,
  conversationEntries: ConversationEntry[],
  speakerSet: Set<string>
): string {
  let text = line.trim();
  if (!text) {
    return "";
  }

  if (text.startsWith("•")) {
    text = text.slice(1).trim();
  } else if (text.startsWith("-")) {
    text = text.replace(/^-+\s*/, "").trim();
  }

  if (!text) {
    return "";
  }

  const colonMatch = text.match(/^([A-Za-z0-9_'`().\-\s]{1,60}):\s*(.+)$/);
  let speaker: string | undefined;
  let statement = text;

  if (colonMatch) {
    speaker = colonMatch[1].trim();
    statement = colonMatch[2].trim();
  } else {
    const impliedMatch = text.match(/^([A-Z][A-Za-z0-9']{2,})(?:\s+|,|--)(.+)$/);
    if (impliedMatch) {
      const candidate = impliedMatch[1].trim();
      if (speakerSet.has(normalizeName(candidate))) {
        speaker = candidate;
        statement = impliedMatch[2].trim();
      }
    }
  }

  if (!statement) {
    return "";
  }

  const body = speaker
    ? buildSentenceWithSpeaker(speaker, statement, conversationEntries, speakerSet)
    : buildSentence(statement);

  return body ? "• " + body : "";
}

function filterAndRankBullets(bullets: string[]): string[] {
  const scored = bullets.map((bullet, index) => ({
    bullet,
    score: scoreBullet(bullet),
    index,
  }));

  const retained = scored.filter((item) => item.score >= 0);
  if (retained.length) {
    return retained
      .sort((a, b) => a.index - b.index)
      .map((item) => item.bullet);
  }

  if (scored.length) {
    const best = scored.reduce((prev, current) =>
      current.score > prev.score ? current : prev
    );
    return [best.bullet];
  }

  return [];
}

function scoreBullet(bullet: string): number {
  const text = bullet.replace(/^•\s*/, "").trim();
  if (!text) return -5;

  let score = 0;

  const length = text.length;
  if (length < 20) score -= 3;
  if (length > 120) score -= 1;

  if (/\b(action item|todo|need to|must|should|task|follow up|deadline|due)\b/i.test(text)) {
    score += 4;
  }

  if (/\bplan|progress|status|update|launch|deploy|issue|fix|bug|release\b/i.test(text)) {
    score += 3;
  }

  if (/\bconfirm|decided|agreed|resolved|concluded\b/i.test(text)) {
    score += 3;
  }

  if (/\bquestion|asked|whether|how|when|what\b/i.test(text)) {
    score += 1;
  }

  if (/\b\d+[smhdw]?\b/.test(text) || /\b\d{1,2}:\d{2}\b/.test(text)) {
    score += 1;
  }

  if (/[A-Za-z].*[A-Za-z].*[A-Za-z]/.test(text)) {
    score += 1;
  }

  if (/^\p{Emoji}+$/u.test(text)) {
    score -= 5;
  }

  if (/^[A-Za-z]+\b/.test(text) && !/\s/.test(text) && text.length <= 6) {
    score -= 4;
  }

  if (/\b(lol|haha|hehe|lmao|rofl|omg)\b/i.test(text)) {
    score -= 4;
  }

  if (text.split(/\s+/).length <= 3) {
    score -= 2;
  }

  return score;
}

function buildSentenceWithSpeaker(
  speaker: string,
  statement: string,
  conversationEntries: ConversationEntry[],
  speakerSet: Set<string>
): string {
  const normalizedSpeaker = capitalizeWords(speaker);
  const cleaned = statement.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return normalizedSpeaker + " shared an update.";
  }

  let clauseSource = cleaned;
  const normalizedSpeakerLower = normalizedSpeaker.toLowerCase();
  if (clauseSource.toLowerCase().startsWith(normalizedSpeakerLower)) {
    clauseSource = clauseSource.slice(normalizedSpeaker.length).trim();
    clauseSource = clauseSource.replace(/^[,:-]\s*/, "").trim();
  }

  if (!clauseSource) {
    return normalizedSpeaker + " shared an update.";
  }

  const sanitizedClause = neutralizeFirstPersonPronouns(
    stripDiscourseMarkers(clauseSource),
    normalizedSpeaker
  )
    .replace(/\s*[–—-]\s*/g, " ")
    .replace(/\s+,/g, ",")
    .trim();

  if (!sanitizedClause) {
    return normalizedSpeaker + " shared an update.";
  }

  if (/[?？]$/.test(clauseSource)) {
    return rewriteQuestionBullet(
      normalizedSpeaker,
      sanitizedClause,
      conversationEntries
    );
  }

  return rewriteStatementBullet(normalizedSpeaker, clauseSource, speakerSet);
}

function buildSentence(statement: string): string {
  const cleaned = statement.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  if (/[?？]$/.test(cleaned)) {
    const core = cleaned.replace(/[?？]+$/, "").trim();
    return capitalizeFirst(core) + "?";
  }

  const sentence = capitalizeFirst(cleaned);
  const punctuation = /[.!?]$/.test(sentence) ? "" : ".";
  return sentence + punctuation;
}

type QuestionParseResult = {
  questionWord: string;
  remainder: string;
  targetName?: string;
  original: string;
};

function rewriteQuestionBullet(
  speaker: string,
  rawQuestion: string,
  conversationEntries: ConversationEntry[]
): string {
  const parsed = parseQuestion(rawQuestion);
  const answerSentence = detectAnswerSentence(
    speaker,
    parsed,
    conversationEntries
  );

  if (answerSentence) {
    return answerSentence;
  }

  return buildAskedSentence(speaker, parsed);
}

function rewriteStatementBullet(
  speaker: string,
  clauseSource: string,
  speakerSet: Set<string>
): string {
  let clause = clauseSource.trim();

  clause = stripDiscourseMarkers(clause);

  if (!clause) {
    return speaker + " shared an update.";
  }

  clause = neutralizeFirstPersonPronouns(clause, speaker);
  clause = clause.replace(/\s*[–—-]\s*/g, " ");
  clause = clause.replace(/\s+,/g, ",");

  if (!clause) {
    return speaker + " shared an update.";
  }

  if (/^i\b/i.test(clause)) {
    clause = clause.replace(/^i\b/i, speaker);
    return ensurePeriod(capitalizeFirst(clause));
  }

  const firstWordMatch = clause.match(/^([A-Za-z0-9'`()-]+)\b/);
  const firstWord = firstWordMatch ? firstWordMatch[1] : undefined;

  if (firstWord && isLikelyProperNoun(firstWord) && !isSameName(firstWord, speaker)) {
    return rewriteThirdPartyStatement(speaker, clause);
  }

  if (
    firstWord &&
    firstWord.toLowerCase() !== speaker.toLowerCase() &&
    speakerSet.has(normalizeName(firstWord))
  ) {
    return ensurePeriod(capitalizeFirst(clause));
  }

  const normalized = lowercaseFirst(clause);
  return ensurePeriod(`${speaker} ${normalized}`);
}

const DISCOURSE_MARKER_REGEX = /^(?:well|ok|okay|oh|anyway|so|hey|hmm|hm|um|uh|alright|right|ah)[\s,;-]+/i;

function stripDiscourseMarkers(text: string): string {
  let working = text.trim();
  while (DISCOURSE_MARKER_REGEX.test(working)) {
    working = working.replace(DISCOURSE_MARKER_REGEX, "").trim();
  }

  working = working.replace(/^(?:never\s?mind)[\s,;-]+/i, "").trim();
  return working;
}

function neutralizeFirstPersonPronouns(text: string, speaker: string): string {
  const speakerName = capitalizeWords(speaker);

  let working = text;

  const replacements: Array<[RegExp, string | ((match: string) => string)]> = [
    [/\bi\'m\b/gi, () => `${speakerName} is`],
    [/\bi\s+am\b/gi, () => `${speakerName} is`],
    [/\bi\'ve\b/gi, () => `${speakerName} has`],
    [/\bi\'ll\b/gi, () => `${speakerName} will`],
    [/\bi\'d\b/gi, () => `${speakerName} would`],
    [/\bI\b/g, speakerName],
    [/\bme\b/gi, "them"],
    [/\bmyself\b/gi, "themself"],
    [/\bmy\b/gi, "their"],
    [/\bmine\b/gi, "theirs"],
  ];

  for (const [pattern, replacement] of replacements) {
    working = working.replace(pattern, replacement as any);
  }

  return working;
}

const COMMON_LOWER_WORDS = new Set([
  "the",
  "this",
  "that",
  "there",
  "then",
  "they",
  "these",
  "those",
  "here",
  "good",
  "great",
  "well",
  "okay",
  "anyway",
  "however",
  "also",
  "maybe",
  "possibly",
  "never",
  "absentees",
]);

function isLikelyProperNoun(word: string): boolean {
  if (!word) return false;
  if (!/^[A-Z][A-Za-z0-9'`()-]*$/.test(word)) {
    return false;
  }

  const lower = word.toLowerCase();
  if (COMMON_LOWER_WORDS.has(lower)) {
    return false;
  }

  return true;
}

function isSameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function rewriteThirdPartyStatement(speaker: string, clause: string): string {
  const sentences = splitIntoSentences(clause);
  if (!sentences.length) {
    return ensurePeriod(`${speaker} shared an update.`);
  }

  const firstSentence = sentences[0].replace(/[.!?]+$/g, "").trim();
  if (!firstSentence) {
    return ensurePeriod(`${speaker} shared an update.`);
  }

  let rewritten = ensurePeriod(`${speaker} relayed that ${firstSentence}`);

  if (sentences.length > 1) {
    const tail = sentences
      .slice(1)
      .map((sentence) => ensurePeriod(capitalizeFirst(sentence.trim())));
    const tailText = tail.filter(Boolean).join(" ");
    if (tailText) {
      rewritten = `${rewritten} ${tailText}`.trim();
    }
  }

  return rewritten;
}

function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const sentences = trimmed.match(/[^.!?]+[.!?]?/g);
  if (sentences && sentences.length) {
    return sentences.map((s) => s.trim()).filter(Boolean);
  }

  return [trimmed];
}

function parseQuestion(question: string): QuestionParseResult {
  const trimmed = question.replace(/[?？]+$/, "").trim();

  let working = trimmed;
  let targetName: string | undefined;
  const commaMatch = working.match(/,\s*(?:lord\s+)?([A-Z][A-Za-z0-9']*(?:\s+[A-Z][A-Za-z0-9']*)*)$/i);
  if (commaMatch) {
    targetName = commaMatch[1].trim();
    working = working.slice(0, commaMatch.index).trim();
  }

  const tokens = working.split(/\s+/);
  const questionWord = tokens[0]?.toLowerCase() ?? "";
  const remainder = working.slice(tokens[0]?.length ?? 0).trim();

  return {
    questionWord,
    remainder,
    targetName,
    original: trimmed,
  };
}

function buildAskedSentence(
  speaker: string,
  parsed: QuestionParseResult
): string {
  const target = parsed.targetName
    ? capitalizeWords(parsed.targetName)
    : undefined;
  const remainder = parsed.remainder.trim();

  if (!remainder) {
    return speaker + " asked a question.";
  }

  if (isYesNoQuestion(parsed.questionWord)) {
    const clause = lowercaseFirst(remainder);
    const targetClause = target ? `${target} whether ${clause}` : `whether ${clause}`;
    return ensurePeriod(`${speaker} asked ${targetClause}`);
  }

  if (parsed.questionWord === "how") {
    const topic = normalizeHowTopic(remainder);
    const targetClause = target ? `${target} about ${topic}` : `about ${topic}`;
    return ensurePeriod(`${speaker} asked ${targetClause}`);
  }

  const questionWord = parsed.questionWord || "what";
  const clause = lowercaseFirst(remainder);
  const targetClause = target ? `${target} ${questionWord} ${clause}` : `${questionWord} ${clause}`;
  return ensurePeriod(`${speaker} asked ${targetClause}`);
}

function detectAnswerSentence(
  asker: string,
  parsed: QuestionParseResult,
  conversationEntries: ConversationEntry[]
): string | null {
  const questionIndex = findConversationEntryIndex(
    conversationEntries,
    asker,
    parsed.original
  );

  if (questionIndex === -1) {
    return null;
  }

  const targetNormalized = parsed.targetName
    ? normalizeName(parsed.targetName)
    : undefined;

  for (let i = questionIndex + 1; i < Math.min(questionIndex + 6, conversationEntries.length); i++) {
    const entry = conversationEntries[i];
    if (!entry.content) continue;

    if (
      targetNormalized &&
      normalizeName(entry.speaker) !== targetNormalized
    ) {
      continue;
    }

    const tone = classifyAnswerTone(entry.content);
    if (!tone) {
      continue;
    }

    const responder = capitalizeWords(entry.speaker);
    const statement = buildAnswerStatement(parsed, tone);

    if (!statement) {
      continue;
    }

    const verb = tone === "positive" ? "confirmed" : "reported";
    return ensurePeriod(`${responder} ${verb} that ${statement}`);
  }

  return null;
}

type AnswerTone = "positive" | "negative";

function buildAnswerStatement(
  parsed: QuestionParseResult,
  tone: AnswerTone
): string {
  const remainder = parsed.remainder.trim();
  if (!remainder) {
    return "";
  }

  if (isYesNoQuestion(parsed.questionWord)) {
    return buildYesNoAnswerStatement(parsed.questionWord, remainder, tone);
  }

  return lowercaseFirst(remainder);
}

function buildYesNoAnswerStatement(
  questionWord: string,
  remainder: string,
  tone: AnswerTone
): string {
  let clause = remainder.trim();
  clause = clause.replace(/^[,\s]+/, "");

  if (/^we\s+/i.test(clause)) {
    const rest = clause.slice(3).trim();
    if (questionWord === "have") {
      clause = tone === "positive"
        ? `we have ${rest}`
        : `we have not ${rest}`;
    } else if (questionWord === "did") {
      clause = tone === "positive"
        ? `we ${rest}`
        : `we did not ${rest}`;
    } else if (questionWord === "are") {
      clause = tone === "positive"
        ? `we are ${rest}`
        : `we are not ${rest}`;
    } else {
      clause = tone === "positive"
        ? `we ${rest}`
        : `we do not ${rest}`;
    }
  } else {
    clause = tone === "positive"
      ? clause
      : `not ${clause}`;
  }

  return lowercaseFirst(clause);
}

function normalizeHowTopic(remainder: string): string {
  let topic = remainder.trim();
  topic = topic.replace(/^(is|are|was|were)\s+/i, "");
  if (!/^the\b/i.test(topic)) {
    topic = "the " + topic;
  }
  return topic.trim();
}

function isYesNoQuestion(word: string): boolean {
  return [
    "have",
    "has",
    "had",
    "did",
    "do",
    "does",
    "is",
    "are",
    "was",
    "were",
    "will",
    "can",
    "could",
    "should",
    "would",
  ].includes(word);
}

function findConversationEntryIndex(
  entries: ConversationEntry[],
  speaker: string,
  statement: string
): number {
  const targetSpeaker = normalizeName(speaker);
  const normalizedStatement = normalizeForMatch(statement);

  for (let i = 0; i < entries.length; i++) {
    if (normalizeName(entries[i].speaker) !== targetSpeaker) {
      continue;
    }
    const normalizedContent = normalizeForMatch(entries[i].content);
    if (
      normalizedContent &&
      (normalizedStatement.includes(normalizedContent) ||
        normalizedContent.includes(normalizedStatement))
    ) {
      return i;
    }
  }

  return -1;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^lord\s+/, "").trim();
}

function classifyAnswerTone(content: string): AnswerTone | null {
  const text = content.toLowerCase();
  if (/(^|\b)(yes|yep|yeah|affirmative|confirmed|done|already|of course|sure)(\b|$)/.test(text)) {
    return "positive";
  }
  if (/(^|\b)(no|nope|not yet|haven't|have not|didn't|cannot|can't)(\b|$)/.test(text)) {
    return "negative";
  }
  return null;
}

function ensurePeriod(sentence: string): string {
  const trimmed = sentence.trim();
  if (!trimmed) {
    return trimmed;
  }
  return /[.!?]$/.test(trimmed) ? trimmed : trimmed + ".";
}

function capitalizeWords(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => capitalizeFirst(part))
    .join(" ");
}

function capitalizeFirst(text: string): string {
  if (!text) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowercaseFirst(text: string): string {
  if (!text) {
    return text;
  }
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const EMOJI_REGEX = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const HUMOR_CUE_REGEXES = [
  /(fooling you all|finally rug(?:ged)?|confession|gotcha|i admit|i lied)/i,
  /(villain arc|not sorry|menace|clowned|ratio'?d|roast)/i,
  /(\$\d+(?:\.\d+)?|tenny|centos|0\.10)/i,
  /(for \d+ years|at last|finally)/i,
  /(haha|lol|lmao|😂|🤣|😭|💀|🖕)/i,
];

function containsEmoji(text: string): boolean {
  return EMOJI_REGEX.test(text);
}

function containsHumorCue(text: string): boolean {
  return HUMOR_CUE_REGEXES.some((regex) => regex.test(text));
}

function hasRepliesDiscord(message: DiscordMessage): boolean {
  return Boolean((message as any)?.referenced_message) || Boolean((message as any)?.message_reference?.message_id);
}

function shouldForceSocialTelegram(messages: TelegramStoredMessage[]): boolean {
  return messages.some((msg) => {
    const text = msg.text ?? "";
    return text.length >= 60 || containsEmoji(text) || containsHumorCue(text) || Boolean(msg.replyToMessageId);
  });
}

function shouldForceSocialDiscord(messages: DiscordMessage[]): boolean {
  return messages.some((msg) => {
    const text = msg.content ?? "";
    return text.length >= 60 || containsEmoji(text) || containsHumorCue(text) || hasRepliesDiscord(msg);
  });
}

function buildSocialFallbackSummaryFromTelegram(messages: TelegramStoredMessage[]): string {
  const sorted = [...messages].sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0));
  const highlight = sorted[0];

  if (!highlight) {
    return "Chat stayed lighthearted with some friendly banter.";
  }

  const author = highlight.authorDisplay || (highlight.authorUsername ? `@${highlight.authorUsername}` : "Someone");
  const snippet = (highlight.text || "").trim();
  const trimmedSnippet = snippet.length > 120 ? `${snippet.slice(0, 117)}…` : snippet;

  return `Chat stayed lively. ${author} sparked reactions: "${trimmedSnippet}"`;
}

function buildSocialFallbackSummaryFromDiscord(messages: DiscordMessage[]): string {
  const sorted = [...messages].sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0));
  const highlight = sorted[0];

  if (!highlight) {
    return "Chat stayed lighthearted with some friendly banter.";
  }

  const author =
    highlight.author?.global_name ||
    highlight.author?.display_name ||
    highlight.author?.username ||
    "Someone";
  const snippet = (highlight.content || "").trim();
  const trimmedSnippet = snippet.length > 120 ? `${snippet.slice(0, 117)}…` : snippet;

  return `Chat stayed lively. ${author} sparked engagement: "${trimmedSnippet}"`;
}

async function fetchMessagesBetween({
  token,
  baseUrl,
  channelId,
  start,
  end,
  initialAfterSnowflake,
  endMessageId,
}: {
  token: string;
  baseUrl: string;
  channelId: string;
  start: Date;
  end: Date;
  initialAfterSnowflake: string;
  endMessageId?: string;
}): Promise<DiscordMessage[]> {
  const messages: DiscordMessage[] = [];
  let after = initialAfterSnowflake;
  let page = 0;
  let shouldStop = false;

  while (!shouldStop && page < MAX_FETCH_PAGES) {
    page += 1;
    const url = new URL(`${baseUrl}/channels/${channelId}/messages`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("after", after);

    const response = await fetch(url, {
      headers: buildDiscordHeaders(token),
    });

    if (!response.ok) {
      const errorBody = await safeJson(response);
      throw new Error(
        `Failed to fetch Discord messages (status ${response.status}): ${
          typeof errorBody === "string"
            ? errorBody
            : JSON.stringify(errorBody)
        }`
      );
    }

    const batch = (await response.json()) as any[];
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    // Log first message structure to debug
    if (page === 1 && batch.length > 0) {
      console.log(`[discord-summary-agent] Sample raw message from Discord API:`, {
        hasContent: 'content' in batch[0],
        contentPreview: batch[0]?.content?.substring(0, 100),
        keys: Object.keys(batch[0] || {}),
      });
    }

    const sortedBatch = [...batch].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() -
        new Date(b.timestamp).getTime()
    );

    for (const message of sortedBatch) {
      if (page === 1) {
        console.log(`[discord-summary-agent] message detail:`, {
          id: message.id,
          author: message.author?.username || message.author?.global_name,
          type: message.type,
          contentPreview: message.content?.substring(0, 100) || null,
          hasEmbeds: Array.isArray(message.embeds) && message.embeds.length > 0,
          embedDescriptions: Array.isArray(message.embeds)
            ? message.embeds
                .map((embed: any) => embed?.description?.substring(0, 100) || null)
                .filter(Boolean)
            : [],
        });
      }
      const timestamp = new Date(message.timestamp);
      if (timestamp < start) {
        after = message.id;
        continue;
      }

      if (timestamp > end) {
        shouldStop = true;
        break;
      }

      if (endMessageId && compareSnowflakes(message.id, endMessageId) > 0) {
        shouldStop = true;
        break;
      }

      if (timestamp >= start && timestamp <= end) {
        messages.push(message);
      }

      after = message.id;

      if (endMessageId && message.id === endMessageId) {
        shouldStop = true;
        break;
      }
    }

    if (batch.length < 100) {
      break;
    }
  }

  return messages;
}

async function fetchChannelInfo({
  token,
  baseUrl,
  channelId,
}: {
  token: string;
  baseUrl: string;
  channelId: string;
}): Promise<DiscordChannelInfo | null> {
  try {
    const response = await fetch(`${baseUrl}/channels/${channelId}`, {
      headers: buildDiscordHeaders(token),
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as DiscordChannelInfo;
  } catch (error) {
    console.warn(
      `[discord-summary-agent] Failed to fetch channel metadata for ${channelId}`,
      error
    );
    return null;
  }
}

async function fetchGuildInfo({
  token,
  baseUrl,
  guildId,
}: {
  token: string;
  baseUrl: string;
  guildId: string;
}): Promise<DiscordGuildInfo | null> {
  try {
    const response = await fetch(`${baseUrl}/guilds/${guildId}`, {
      headers: buildDiscordHeaders(token),
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as DiscordGuildInfo;
  } catch (error) {
    console.warn(
      `[discord-summary-agent] Failed to fetch guild metadata for ${guildId}`,
      error
    );
    return null;
  }
}

function parseDiscordMessageUrl(url: string): DiscordMessageLinkParts | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 4 || segments[0] !== "channels") {
      return null;
    }

    const guildSegment = segments[1] ?? "";
    const channelSegment = segments[2] ?? "";
    const messageSegment = segments[3] ?? "";

    if (!/^\d+$/.test(channelSegment) || !/^\d+$/.test(messageSegment)) {
      return null;
    }

    return {
      guildId: guildSegment && guildSegment !== "@me" ? guildSegment : null,
      channelId: channelSegment,
      messageId: messageSegment,
    };
  } catch {
    return null;
  }
}

function discordSnowflakeToDate(id: string): Date {
  const value = BigInt(id);
  const timestamp = Number((value >> 22n) + DISCORD_EPOCH);
  return new Date(timestamp);
}

function compareSnowflakes(a: string, b: string): number {
  const aValue = BigInt(a);
  const bValue = BigInt(b);
  if (aValue === bValue) {
    return 0;
  }
  return aValue < bValue ? -1 : 1;
}

function decrementSnowflake(id: string): string {
  const value = BigInt(id);
  if (value <= 0n) {
    return "0";
  }
  return (value - 1n).toString();
}

function snowflakeFromDate(date: Date, adjustment: bigint = 0n): string {
  const ms = BigInt(date.getTime());
  if (ms < DISCORD_EPOCH) {
    throw new Error("Date precedes the Discord epoch (2015-01-01).");
  }

  const base = (ms - DISCORD_EPOCH) << 22n;
  const value = base + adjustment;
  return (value > 0n ? value : 0n).toString();
}

function buildDiscordSummarizerMessages(
  messages: any[],
  guildMeta: any | null
): SummarizerMessage[] {
  return messages.map((message) => {
    const authorName =
      message?.author?.global_name ||
      message?.author?.display_name ||
      message?.author?.username ||
      "Unknown";

    const textParts: string[] = [];
    if (message?.content) {
      textParts.push(message.content);
    }
    if (Array.isArray(message?.embeds)) {
      for (const embed of message.embeds) {
        if (embed?.title) {
          textParts.push(`Embed title: ${embed.title}`);
        }
        if (embed?.description) {
          textParts.push(embed.description);
        }
        if (Array.isArray(embed?.fields)) {
          for (const field of embed.fields) {
            if (field?.name || field?.value) {
              textParts.push(`${field?.name ?? ""} ${field?.value ?? ""}`.trim());
            }
          }
        }
      }
    }

    const attachments: SummarizerAttachment[] = Array.isArray(message?.attachments)
      ? message.attachments.map((attachment: any) => ({
          url: attachment?.url ?? "",
          filename: attachment?.filename ?? null,
          content_type: attachment?.content_type ?? null,
          caption: attachment?.description ?? null,
        }))
      : [];

    const embedAttachments: SummarizerAttachment[] = Array.isArray(message?.embeds)
      ? message.embeds
          .map((embed: any) => {
            if (embed?.url) {
              return {
                url: embed.url,
                filename: embed?.title ?? null,
                content_type: embed?.type ?? null,
                caption: embed?.description ?? null,
              } as SummarizerAttachment;
            }
            return null;
          })
          .filter(Boolean) as SummarizerAttachment[]
      : [];

    const reactions: SummarizerReaction[] = Array.isArray(message?.reactions)
      ? message.reactions.map((reaction: any) => {
          const emoji = reaction?.emoji;
          let label: string | null = null;
          if (!emoji) {
            label = null;
          } else if (emoji.id) {
            label = emoji.name ? `${emoji.name}:${emoji.id}` : emoji.id;
          } else {
            label = emoji.name ?? null;
          }
          return {
            emoji: label,
            count: Number(reaction?.count ?? 0),
          };
        })
      : [];

    const combinedAttachments = [...attachments, ...embedAttachments];

    const text = textParts
      .filter(Boolean)
      .join(" \n ")
      .replace(/\s+/g, " ")
      .trim();

    const isOwner =
      Boolean(guildMeta?.owner_id) && message?.author?.id
        ? guildMeta.owner_id === message.author.id
        : false;

    return {
      id: String(message?.id ?? `temp-${Date.now()}`),
      timestamp: message?.timestamp ?? new Date().toISOString(),
      author: authorName,
      is_admin: isOwner,
      is_bot: Boolean(message?.author?.bot),
      text: text || (combinedAttachments.length ? "[attachment]" : ""),
      attachments: combinedAttachments,
      reactions,
      reply_to_id: message?.message_reference?.message_id
        ? String(message.message_reference.message_id)
        : undefined,
      thread_id: message?.thread?.id
        ? String(message.thread.id)
        : message?.thread_id
        ? String(message.thread_id)
        : undefined,
      event_type: message?.type !== undefined ? String(message.type) : undefined,
    };
  });
}

function buildTelegramSummarizerMessages(
  messages: TelegramStoredMessage[]
): SummarizerMessage[] {
  return messages.map((msg) => {
    const authorName =
      msg.authorDisplay ||
      (msg.authorUsername ? `@${msg.authorUsername}` : "Member");
    return {
      id: String(msg.messageId),
      timestamp: new Date(msg.timestampMs).toISOString(),
      author: authorName,
      is_admin: false,
      is_bot: false,
      text: msg.text.trim(),
      attachments: [],
      reactions: [],
      reply_to_id: msg.replyToMessageId
        ? String(msg.replyToMessageId)
        : undefined,
      thread_id: undefined,
      event_type: "message",
    };
  });
}

function buildSummarizerPayload(
  platform: "discord" | "telegram",
  windowLabel: string,
  maxChars: number,
  messages: SummarizerMessage[]
): string {
  return JSON.stringify(
    {
      platform,
      window: windowLabel,
      max_chars: maxChars,
      messages,
    },
    null,
    2
  );
}

function buildDiscordHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "discord-summary-agent (https://daydreams.systems)",
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}
