# Testing the Luma Event Search Bot

## Step-by-Step Terminal Commands

### 1. Navigate to the dreams repo
```bash
cd /Users/cumberlord/dreams
```

### 2. Verify you're in the right directory
```bash
pwd
# Should output: /Users/cumberlord/dreams

ls -la
# Should show: src/, package.json, bun.lock, etc.
```

### 3. Check the current branch and status
```bash
git status
# Should show you're on main branch (or your current branch)
```

### 4. Install dependencies (if needed)
```bash
bun install
```

### 5. Test the Luma search function directly
```bash
# Test the search function
bun run src/luma.ts
```

Or create a quick test script:

```bash
# Create a test file
cat > test-luma.ts << 'EOF'
import { searchLumaEvents, formatEventsForTelegram } from "./src/luma";

async function test() {
  console.log("Testing topic search: crypto\n");
  const events = await searchLumaEvents({
    query: "crypto",
    searchType: "topic",
    limit: 5
  });
  
  console.log(`Found ${events.length} events\n`);
  console.log(formatEventsForTelegram(events));
  
  console.log("\n\nTesting topic search: AI\n");
  const aiEvents = await searchLumaEvents({
    query: "AI",
    searchType: "topic",
    limit: 5
  });
  
  console.log(`Found ${aiEvents.length} events\n`);
  console.log(formatEventsForTelegram(aiEvents));
}

test().catch(console.error);
EOF

# Run the test
bun run test-luma.ts
```

### 6. Test the event API (to see location data)
```bash
bun run scripts/test-event-api.ts
```

### 7. Run type checking
```bash
bun run typecheck
```

### 8. Start the bot in development mode
```bash
# Make sure you have .env file with TELEGRAM_BOT_TOKEN
bun run dev
```

## Quick Verification Checklist

- [ ] You're in `/Users/cumberlord/dreams`
- [ ] `src/luma.ts` exists and has the search functions
- [ ] `src/telegram.ts` has the `/search_events` command
- [ ] `src/agent.ts` has the "search luma events" entrypoint
- [ ] Dependencies are installed (`bun install`)

## Environment Variables Needed

Create a `.env` file with:
```
TELEGRAM_BOT_TOKEN=your_bot_token_here
AGENT_URL=http://localhost:8787
PUBLIC_WEB_URL=http://localhost:8787
```

## Testing the Full Flow

1. Start the bot: `bun run dev`
2. Open Telegram and message your bot
3. Try: `/search_events on crypto`
4. Pay via x402 (if configured)
5. Should receive event links

