/**
 * Script to register Discord slash commands
 * Run with: bun run scripts/register-slash-command.ts
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // Optional: for guild-specific commands

if (!BOT_TOKEN || !APPLICATION_ID) {
  console.error("Error: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be set");
  process.exit(1);
}

const command = {
  name: "summarise",
  description: "Summarise recent messages in this channel",
  type: 1, // CHAT_INPUT
  options: [
    {
      name: "minutes",
      description: "Number of minutes to look back (default: 60)",
      type: 4, // INTEGER
      required: false,
      min_value: 1,
      max_value: 1440, // 24 hours
    },
  ],
};

async function registerCommand() {
  const url = GUILD_ID
    ? `${DISCORD_API_BASE}/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
    : `${DISCORD_API_BASE}/applications/${APPLICATION_ID}/commands`;

  console.log(`Registering command at: ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Failed to register command: ${response.status} ${error}`);
    process.exit(1);
  }

  const result = await response.json();
  console.log("✅ Command registered successfully!");
  console.log(JSON.stringify(result, null, 2));
}

registerCommand().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

