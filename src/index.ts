import { app, executeSummariseChat } from "./agent";
import nacl from "tweetnacl";

const port = Number(process.env.PORT ?? 8787);
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_API_DEFAULT_BASE = "https://discord.com/api/v10";

// Store Discord webhook info temporarily for payment callbacks
// Map: interaction_token -> { application_id, channel_id, guild_id, lookbackMinutes }
const pendingDiscordCallbacks = new Map<string, {
  applicationId: string;
  channelId: string;
  guildId: string | null;
  lookbackMinutes: number;
  expiresAt: number;
}>();

// Clean up expired callbacks every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of pendingDiscordCallbacks.entries()) {
    if (data.expiresAt < now) {
      pendingDiscordCallbacks.delete(token);
    }
  }
}, 30 * 60 * 1000);

// Discord signature verification using Ed25519
function verifyDiscordRequest(
  body: string,
  signature: string,
  timestamp: string
): boolean {
  if (!PUBLIC_KEY) {
    console.warn("[discord] DISCORD_PUBLIC_KEY not set, skipping signature verification");
    return false; // Don't allow if PUBLIC_KEY is required
  }

  try {
    // Convert hex strings to Uint8Arrays
    const publicKeyBytes = Uint8Array.from(
      Buffer.from(PUBLIC_KEY, "hex")
    );
    const signatureBytes = Uint8Array.from(
      Buffer.from(signature, "hex")
    );

    // Discord signs: timestamp + body
    const message = new TextEncoder().encode(timestamp + body);

    // Verify signature using Ed25519
    const isValid = nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
    
    if (!isValid) {
      console.warn("[discord] Signature verification failed");
    }
    
    return isValid;
  } catch (error) {
    console.error("[discord] Signature verification error:", error);
    return false;
  }
}

// Handle Discord interactions
async function handleDiscordInteraction(req: Request): Promise<Response> {
  try {
    const signature = req.headers.get("x-signature-ed25519");
    const timestamp = req.headers.get("x-signature-timestamp");

    const body = await req.text();
    
    // Verify signature FIRST if PUBLIC_KEY is set (required for Discord verification)
    if (PUBLIC_KEY) {
      if (!signature || !timestamp) {
        console.warn("[discord] Missing signature headers");
        return Response.json({ error: "Missing signature headers" }, { status: 401 });
      }

      const isValid = verifyDiscordRequest(body, signature, timestamp);
      if (!isValid) {
        console.warn("[discord] Invalid signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }
    } else {
      console.warn("[discord] DISCORD_PUBLIC_KEY not set - signature verification disabled");
    }
    
    // Parse interaction after signature verification
    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch (e) {
      console.error("[discord] Failed to parse interaction body:", e);
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Handle PING (Discord's verification)
    if (interaction.type === 1) {
      console.log("[discord] Received PING, responding with PONG");
      return Response.json({ type: 1 });
    }

  // Handle APPLICATION_COMMAND
  if (interaction.type === 2) {
    const { name, options } = interaction.data || {};
    // channel_id and guild_id are at the interaction level, not in data
    const channel_id = interaction.channel_id || interaction.channel?.id;
    const guild_id = interaction.guild_id || interaction.guild?.id;

    if (name === "summarise") {
      // Get lookback minutes from options (default: 60)
      const lookbackOption = options?.find((opt: any) => opt.name === "minutes");
      const lookbackMinutes = lookbackOption?.value ?? 60;
      
      // Debug: log interaction structure
      console.log(`[discord] Interaction structure:`, JSON.stringify({
        channel_id: interaction.channel_id,
        channel: interaction.channel,
        guild_id: interaction.guild_id,
        guild: interaction.guild,
        data: interaction.data,
      }, null, 2));

      // Validate required fields
      if (!channel_id) {
        console.error(`[discord] Missing channel_id in interaction:`, JSON.stringify(interaction, null, 2));
        const followupUrl = `${process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE}/webhooks/${interaction.application_id}/${interaction.token}`;
        await fetch(followupUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "❌ Error: Could not determine channel ID from interaction.",
          }),
        });
        return Response.json({ error: "Missing channel_id" }, { status: 400 });
      }

      // Respond immediately with "thinking"
      const initialResponse = Response.json({
        type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });

      // Process in background - route through x402 payment-enabled entrypoint
      (async () => {
        try {
          console.log(`[discord] Processing summarise command: channel=${channel_id}, guild=${guild_id}, minutes=${lookbackMinutes}`);
          
          const baseUrl =
            process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
          const followupUrl = `${baseUrl}/webhooks/${interaction.application_id}/${interaction.token}`;

          // Call the agent-kit entrypoint (which handles x402 payments)
          const agentBaseUrl = process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
          const entrypointUrl = `${agentBaseUrl}/entrypoints/summarise%20chat/invoke`;
          
          console.log(`[discord] Calling entrypoint: ${entrypointUrl}`);

          // Ensure channel_id is valid
          if (!channel_id || typeof channel_id !== "string" || channel_id.trim() === "") {
            throw new Error(`Invalid channel_id: ${channel_id}. Please try the command again.`);
          }

          console.log(`[discord] Sending request with channelId="${channel_id}", serverId="${guild_id}", lookbackMinutes=${lookbackMinutes}`);

          // Make request to entrypoint (without payment headers - it will return payment instructions)
          const entrypointResponse = await fetch(entrypointUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: {
                channelId: channel_id.trim(),
                serverId: guild_id || undefined,
                lookbackMinutes,
              },
            }),
          });

          const responseData = await entrypointResponse.json();

          // Check for validation errors
          if (entrypointResponse.status === 400) {
            const errorMsg = responseData.error?.issues?.[0]?.message || responseData.error?.message || "Validation error";
            console.error(`[discord] Entrypoint validation error:`, responseData);
            await fetch(followupUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `❌ **Validation Error**\n${errorMsg}\n\nIf this persists, please check Railway logs for details.`,
              }),
            });
            return;
          }

          // Log the response status for debugging
          console.log(`[discord] Entrypoint response status: ${entrypointResponse.status}`);

          // Check if payment is required (402 or payment_required error)
          // Also check if the response indicates payment was needed but wasn't provided
          let requiresPayment = 
            entrypointResponse.status === 402 || 
            responseData.error?.code === "payment_required" ||
            responseData.payment_required === true ||
            (entrypointResponse.headers.get("x-payment-required") === "true");

          // If we got a successful response but payment should be required, 
          // we need to enforce payment manually
          // Agent-kit may not enforce payment automatically for internal calls
          // For Discord commands, we should ALWAYS require payment via x402
          if (entrypointResponse.status === 200 && !requiresPayment) {
            console.log(`[discord] Entrypoint returned success without payment - enforcing payment requirement for Discord`);
            requiresPayment = true;
          }

          if (requiresPayment) {
            // Store Discord webhook info for callback (expires in 1 hour)
            pendingDiscordCallbacks.set(interaction.token, {
              applicationId: interaction.application_id,
              channelId: channel_id,
              guildId: guild_id,
              lookbackMinutes,
              expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
            });

            // Send payment instructions to Discord user
            const callbackParam = encodeURIComponent(interaction.token);
            const paymentUrl = `${agentBaseUrl}/pay?channelId=${channel_id}&serverId=${guild_id || ""}&lookbackMinutes=${lookbackMinutes}&discord_callback=${callbackParam}`;
            
            // Get price from entrypoint config or default
            const price = process.env.ENTRYPOINT_PRICE || "0.10";
            const currency = process.env.PAYMENT_CURRENCY || "USDC";
            
            const paymentMessage = `💳 **Payment Required**

To summarise this channel, please pay **$${price} ${currency}** via x402.

🔗 **Pay & Summarise:**
${paymentUrl}

After payment, your summary will appear here automatically.`;

            await fetch(followupUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: paymentMessage,
              }),
            });
            return;
          }

          if (!entrypointResponse.ok) {
            throw new Error(`Entrypoint error: ${entrypointResponse.status} ${JSON.stringify(responseData)}`);
          }

          // Success - format and send result
          const output = responseData.output || responseData;
          let content = `**Summary**\n${output.summary || "No summary available"}\n\n`;
          
          if (output.actionables && output.actionables.length > 0) {
            content += `**Action Items**\n${output.actionables.map((a: string, i: number) => `${i + 1}. ${a}`).join("\n")}`;
          } else {
            content += `*No action items identified.*`;
          }

          console.log(`[discord] Summary completed: ${(output.summary || "").substring(0, 50)}...`);

          const followupResponse = await fetch(followupUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content,
            }),
          });

          if (!followupResponse.ok) {
            const errorText = await followupResponse.text();
            console.error(`[discord] Failed to send follow-up: ${followupResponse.status} ${errorText}`);
            throw new Error(`Failed to send response: ${followupResponse.status}`);
          }

          console.log(`[discord] Successfully sent summary response`);
        } catch (error: any) {
          console.error(`[discord] Error processing command:`, error);
          const errorMsg = error.message || "An error occurred";
          const baseUrl =
            process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
          const followupUrl = `${baseUrl}/webhooks/${interaction.application_id}/${interaction.token}`;

          try {
            const errorResponse = await fetch(followupUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `❌ Error: ${errorMsg}`,
              }),
            });

            if (!errorResponse.ok) {
              const errorText = await errorResponse.text();
              console.error(`[discord] Failed to send error message: ${errorResponse.status} ${errorText}`);
            }
          } catch (fetchError) {
            console.error(`[discord] Failed to send error response:`, fetchError);
          }
        }
      })();

      return initialResponse;
    }
  }

    return Response.json({ error: "Unknown interaction type" }, { status: 400 });
  } catch (error: any) {
    console.error("[discord] Error handling interaction:", error);
    return Response.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}

// Handle Discord callback after payment
async function handleDiscordCallback(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { discord_token, result } = body;

    if (!discord_token) {
      return Response.json({ error: "Missing discord_token" }, { status: 400 });
    }

    const callbackData = pendingDiscordCallbacks.get(discord_token);
    if (!callbackData) {
      return Response.json({ error: "Invalid or expired callback token" }, { status: 404 });
    }

    // Remove from pending
    pendingDiscordCallbacks.delete(discord_token);

    // Send result to Discord
    const baseUrl = process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
    const followupUrl = `${baseUrl}/webhooks/${callbackData.applicationId}/${discord_token}`;

    const output = result?.output || result;
    
    // Extract summary, filtering out any payment-related messages that might have leaked in
    let summary = output?.summary || "No summary available";
    
    // Remove payment request messages that might have been included in the summary
    summary = summary
      .replace(/💳\s*\*\*Payment Required\*\*[\s\S]*?automatically\./gi, "")
      .replace(/🔗\s*\*\*Pay.*?\n/gi, "")
      .replace(/https?:\/\/[^\s]*pay[^\s]*/gi, "")
      .replace(/To summarise this channel, please pay.*?via x402\./gi, "")
      .trim();
    
    // If summary is empty or too short after filtering, use original
    if (!summary || summary.length < 10) {
      summary = output?.summary || "Summary generated successfully.";
    }
    
    let content = `✅ **Payment Confirmed**\n\n`;
    content += `**Summary**\n${summary}\n\n`;
    
    if (output?.actionables && output.actionables.length > 0) {
      content += `**Action Items**\n${output.actionables.map((a: string, i: number) => `${i + 1}. ${a}`).join("\n")}`;
    } else {
      content += `*No action items identified.*`;
    }
    
    // Log payment verification info if available
    // x402 payments should include payment metadata in the response
    console.log(`[payment] Payment callback received for token: ${discord_token.substring(0, 20)}...`);
    console.log(`[payment] Result keys:`, Object.keys(result || {}));
    if (result?.payment || result?.x402Payment || result?.paymentTx) {
      const paymentInfo = result?.payment || result?.x402Payment || result?.paymentTx;
      console.log(`[payment] Payment verified:`, {
        txHash: paymentInfo.txHash || paymentInfo.hash || paymentInfo.transactionHash,
        from: paymentInfo.from || paymentInfo.sender || paymentInfo.payer,
        amount: paymentInfo.amount || paymentInfo.value,
        currency: paymentInfo.currency || paymentInfo.token || "USDC"
      });
    } else {
      console.log(`[payment] No payment metadata found in result. Full result:`, JSON.stringify(result, null, 2).substring(0, 500));
    }

    const followupResponse = await fetch(followupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
      }),
    });

    if (!followupResponse.ok) {
      const errorText = await followupResponse.text();
      console.error(`[discord] Failed to send callback result: ${followupResponse.status} ${errorText}`);
      return Response.json({ error: "Failed to send result to Discord" }, { status: 500 });
    }

    console.log(`[discord] Successfully sent callback result to Discord`);
    return Response.json({ success: true });
  } catch (error: any) {
    console.error("[discord] Error handling callback:", error);
    return Response.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // Health checks
    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    // Discord interactions endpoint
    if (url.pathname === "/interactions") {
      if (req.method === "POST") {
        return handleDiscordInteraction(req);
      }
      // Allow GET for testing
      if (req.method === "GET") {
        return Response.json({ 
          status: "ok", 
          message: "Discord interactions endpoint is active",
          publicKey: PUBLIC_KEY ? "set" : "not set"
        });
      }
    }

    // Discord payment callback endpoint
    if (url.pathname === "/discord-callback" && req.method === "POST") {
      return handleDiscordCallback(req);
    }

    // Payment page - handles GET requests and shows payment UI
    if (url.pathname === "/pay" && req.method === "GET") {
      const channelId = url.searchParams.get("channelId");
      const serverId = url.searchParams.get("serverId");
      const lookbackMinutes = url.searchParams.get("lookbackMinutes");
      const discordCallback = url.searchParams.get("discord_callback");
      
      if (!channelId || !lookbackMinutes) {
        return Response.json({ error: "Missing required parameters" }, { status: 400 });
      }

      const agentBaseUrl = process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
      const entrypointUrl = `${agentBaseUrl}/entrypoints/summarise%20chat/invoke`;
      const price = process.env.ENTRYPOINT_PRICE || "0.10";
      const currency = process.env.PAYMENT_CURRENCY || "USDC";
      
      return new Response(`<!DOCTYPE html>
<html>
<head>
  <title>Pay to Summarise Discord Channel</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .container { background: #f5f5f5; padding: 30px; border-radius: 12px; }
    h1 { color: #333; margin-top: 0; }
    .info { background: white; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .button { background: #5865F2; color: white; padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; margin-top: 20px; }
    .button:hover { background: #4752C4; }
  </style>
</head>
<body>
  <div class="container">
    <h1>💳 Pay to Summarise Discord Channel</h1>
    <div class="info">
      <p><strong>Price:</strong> $${price} ${currency}</p>
      <p><strong>Channel ID:</strong> ${channelId}</p>
      <p><strong>Lookback:</strong> ${lookbackMinutes} minutes</p>
    </div>
    <p>Click below to pay via x402. After payment, your summary will automatically appear in Discord.</p>
    <button class="button" onclick="pay()">Pay $${price} ${currency}</button>
    <div id="status" style="margin-top: 20px;"></div>
  </div>
  <script type="module">
    import { x402Fetch } from 'https://cdn.jsdelivr.net/npm/x402-fetch@0.7.0/+esm';
    
    async function pay() {
      const status = document.getElementById('status');
      status.innerHTML = '<p>Connecting wallet...</p>';
      
      try {
        // Use x402-fetch to actually process payment
        const response = await x402Fetch('${entrypointUrl}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: {
              channelId: '${channelId}',
              serverId: '${serverId || ""}',
              lookbackMinutes: ${lookbackMinutes},
            },
          }),
        });

        const data = await response.json();
        
        if (response.ok) {
          // Log payment info if available
          if (data.payment) {
            console.log('Payment details:', {
              txHash: data.payment.txHash,
              from: data.payment.from,
              amount: data.payment.amount,
              currency: data.payment.currency
            });
            status.innerHTML = \`<p style="color: green;">✅ Payment successful!</p>
              <p style="font-size: 12px; color: #666;">TX: \${data.payment.txHash?.substring(0, 20)}...</p>
              <p>Check Discord for your summary.</p>\`;
          } else {
            status.innerHTML = '<p style="color: green;">✅ Payment successful! Check Discord for your summary.</p>';
          }
          
          ${discordCallback ? `fetch('/discord-callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              discord_token: '${discordCallback}',
              result: data,
            }),
          }).catch(err => console.error('Callback error:', err));` : ''}
        } else if (response.status === 402) {
          status.innerHTML = '<p style="color: orange;">Payment required. Please connect your x402 wallet and try again.</p>';
        } else {
          status.innerHTML = '<p style="color: red;">Error: ' + (data.error?.message || JSON.stringify(data)) + '</p>';
        }
      } catch (error) {
        console.error('Payment error:', error);
        status.innerHTML = '<p style="color: red;">Error: ' + error.message + '</p>';
        if (error.message.includes('wallet') || error.message.includes('user rejected')) {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Make sure you have an x402 wallet installed and approved the transaction.</p>';
        }
      }
    }
    window.pay = pay;
  </script>
</body>
</html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Agent app routes - intercept entrypoint responses for Discord callbacks
    if (url.pathname.includes("/entrypoints/") && url.pathname.includes("/invoke")) {
      const discordCallback = url.searchParams.get("discord_callback");
      
      if (discordCallback) {
        // Clone the request and call the app
        const response = await app.fetch(req);
        
        // If successful (2xx), also send result to Discord callback
        if (response.status >= 200 && response.status < 300) {
          try {
            const result = await response.clone().json();
            
            // POST to Discord callback endpoint
            const callbackUrl = new URL("/discord-callback", url.origin);
            await fetch(callbackUrl.toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                discord_token: decodeURIComponent(discordCallback),
                result,
              }),
            }).catch((err) => {
              console.error("[discord] Failed to trigger callback:", err);
            });
          } catch (err) {
            console.error("[discord] Failed to parse entrypoint response:", err);
          }
        }
        
        return response;
      }
    }
    
    // Agent app routes
    return app.fetch(req);
  },
});

console.log(
  `🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`
);
console.log(
  `📡 Discord interactions: http://${server.hostname}:${server.port}/interactions`
);
