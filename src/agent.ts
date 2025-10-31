import { z } from "zod";
import {
  createAgentApp,
  createAxLLMClient,
  AgentKitConfig,
} from "@lucid-dreams/agent-kit";
import { flow } from "@ax-llm/ax";

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

const DISCORD_API_DEFAULT_BASE = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n;
const MAX_FETCH_PAGES = 10; // safeguards agent costs by limiting to 1,000 messages.

// USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const configOverrides: AgentKitConfig = {
  payments: {
    facilitatorUrl:
      (process.env.FACILITATOR_URL as any) ??
      "https://facilitator.daydreams.systems",
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
});

if (!axClient.isConfigured()) {
  console.warn(
    "[discord-summary-agent] Ax LLM provider not configured — defaulting to scripted fallbacks."
  );
}

const discordSummaryFlow = flow<{
  conversation: string;
  timeWindow: string;
  channelLabel: string;
  lookbackMinutes?: number;
}>()
  .node(
    "summarizer",
    'conversation:string, timeWindow:string, channelLabel:string, lookbackMinutes?:number -> summary:string "You are a friendly Discord channel summarizer. Analyze the conversation and provide a cordial summary in bullet point format. Start with a brief greeting based on the time of day, then say something like: Here is what happened in the last X minutes: and provide bullet points covering: key conclusions reached, any opposition or disagreements, important highlights, and anything funny or notable. Messages with many emoji reactions (shown as emoji xN format, e.g. 😀 x5) are likely important or funny - prioritize these in your summary. Do NOT include timestamps in your summary. Be concise and friendly. Format as bullet points using • characters."'
  )
  .node(
    "actionables",
    'conversation:string, summary:string -> actionables:string[] "List concrete follow-up actions mentioned or implied by the discussion. Whenever possible include the owner (e.g. @user) and a short description. Return up to five items. If nothing actionable was discussed, return an empty list."'
  )
  .execute("summarizer", (state) => ({
    conversation: state.conversation,
    timeWindow: state.timeWindow,
    channelLabel: state.channelLabel,
    lookbackMinutes: state.lookbackMinutes,
  }))
  .execute("actionables", (state) => ({
    conversation: state.conversation,
    summary: state.summarizerResult.summary as string,
  }))
  .returns((state) => ({
    summary: state.summarizerResult.summary as string,
    actionables: Array.isArray(state.actionablesResult.actionables)
      ? (state.actionablesResult.actionables as string[])
      : [],
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

    const conversation = formatConversation(messages);
    const timeWindow = `${start.toISOString()} → ${end.toISOString()} (${rangeLabel})`;

    const llm = axClient.ax;
    if (!llm) {
      const fallbackSummary = conversation
        .split("\n")
        .slice(0, 5)
        .join("\n")
        .trim();

      return {
        output: {
          summary:
            fallbackSummary ||
            `Messages retrieved (${rangeLabel}), but AxFlow is not configured to generate a summary.`,
          actionables: [],
        },
        model: "axllm-fallback",
      };
    }

    const result = await discordSummaryFlow.forward(llm, {
      conversation,
      timeWindow,
      channelLabel,
      lookbackMinutes: lookbackMinutes,
    });

    const usageEntry = discordSummaryFlow.getUsage().at(-1);
    discordSummaryFlow.resetUsage();

    // Clean up summary: remove timestamps and payment-related content
    let summary = result.summary ?? "";
    
    // Remove timestamps in various formats
    summary = summary
      .replace(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/g, "") // ISO timestamps
      .replace(/\[[^\]]*\d{4}[^\]]*\]/g, "") // Any bracketed timestamps
      .replace(/x402 Summariser[^\n]*\n?/gi, "") // Remove "x402 Summariser:" prefix
      .trim();

    return {
      output: {
        summary: summary || "Summary generated successfully.",
        actionables: Array.isArray(result.actionables)
          ? result.actionables
          : [],
      },
      model: usageEntry?.model,
    };
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
  const timeWindow = `${start.toISOString()} → ${end.toISOString()} (${rangeLabel})`;

  const llm = axClient.ax;
  if (!llm) {
    const fallbackSummary = conversation
      .split("\n")
      .slice(0, 5)
      .join("\n")
      .trim();

    return {
      summary:
        fallbackSummary ||
        `Messages retrieved (${rangeLabel}), but AxFlow is not configured to generate a summary.`,
      actionables: [],
    };
  }

  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("LLM request timed out after 30 seconds")), 30000);
    });

    const flowPromise = discordSummaryFlow.forward(llm, {
      conversation,
      timeWindow,
      channelLabel,
      lookbackMinutes: lookbackMinutes,
    });

    const result = await Promise.race([flowPromise, timeoutPromise]) as typeof flowPromise extends Promise<infer T> ? T : never;

    discordSummaryFlow.resetUsage();

    // Clean up summary: remove timestamps and payment-related content
    let summary = result.summary ?? "";
    
    // Remove timestamps in various formats
    summary = summary
      .replace(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/g, "") // ISO timestamps
      .replace(/\[[^\]]*\d{4}[^\]]*\]/g, "") // Any bracketed timestamps
      .replace(/x402 Summariser[^\n]*\n?/gi, "") // Remove "x402 Summariser:" prefix
      .trim();

    return {
      summary: summary || "Summary generated successfully.",
      actionables: Array.isArray(result.actionables)
        ? (result.actionables as string[])
        : [],
    };
  } catch (error: any) {
    console.error("[discord-summary-agent] LLM flow error:", error);
    // Fallback to simple summary if LLM fails
    const fallbackSummary = conversation
      .split("\n")
      .slice(0, 5)
      .join("\n")
      .trim();

    return {
      summary:
        fallbackSummary ||
        `Messages retrieved (${rangeLabel}), but failed to generate AI summary: ${error.message}`,
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

    const batch = (await response.json()) as DiscordMessage[];
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    const sortedBatch = [...batch].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() -
        new Date(b.timestamp).getTime()
    );

    for (const message of sortedBatch) {
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
