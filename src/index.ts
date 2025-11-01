import { app, executeSummariseChat } from "./agent";
import { exact } from "x402/schemes";
import { findMatchingPaymentRequirements } from "x402/shared";
import { useFacilitator } from "x402/verify";
import { settleResponseHeader } from "x402/types";
import nacl from "tweetnacl";

const port = Number(process.env.PORT ?? 8787);
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_API_DEFAULT_BASE = "https://discord.com/api/v10";

// Payment constants
const USDC_DECIMALS = 6;
const DEFAULT_PRICE_USDC = BigInt(100000); // 0.10 USDC (100000 / 10^6)
const PAYMENT_CALLBACK_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_LOOKBACK_MINUTES = 8 * 60; // 8 hours
const EPHEMERAL_FLAG = 1 << 6;

function validateLookback(rawValue: unknown) {
  const numeric = Number(rawValue);

  if (!Number.isFinite(numeric)) {
    return { error: "Lookback must be provided as a number of minutes." } as const;
  }

  const minutes = Math.floor(numeric);

  if (minutes <= 0) {
    return { error: "Lookback must be at least 1 minute." } as const;
  }

  if (minutes > MAX_LOOKBACK_MINUTES) {
    return {
      error: `Lookback may not exceed ${MAX_LOOKBACK_MINUTES} minutes (8 hours).`,
    } as const;
  }

  return { minutes } as const;
}

function makeEphemeralResponse(message: string): Response {
  return Response.json({
    type: 4,
    data: {
      content: message,
      flags: EPHEMERAL_FLAG,
    },
  });
}

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
        const lookbackValidation = validateLookback(lookbackOption?.value ?? 60);

        if ("error" in lookbackValidation) {
          return makeEphemeralResponse(`❌ ${lookbackValidation.error}`);
        }

        const { minutes: lookbackMinutes } = lookbackValidation;

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
          console.log(`[discord] Summarise request: channel=${channel_id}, guild=${guild_id}, minutes=${lookbackMinutes}`);

          const baseUrl =
            process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
          const followupUrl = `${baseUrl}/webhooks/${interaction.application_id}/${interaction.token}`;

          // Call the agent-kit entrypoint (which handles x402 payments)
          const agentBaseUrl = process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
          const entrypointUrl = `${agentBaseUrl}/entrypoints/summarise%20chat/invoke`;

          // Ensure channel_id is valid
          if (!channel_id || typeof channel_id !== "string" || channel_id.trim() === "") {
            throw new Error(`Invalid channel_id: ${channel_id}. Please try the command again.`);
          }
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
            // Store Discord webhook info for callback
            pendingDiscordCallbacks.set(interaction.token, {
              applicationId: interaction.application_id,
              channelId: channel_id,
              guildId: guild_id,
              lookbackMinutes,
              expiresAt: Date.now() + PAYMENT_CALLBACK_EXPIRY_MS,
            });

            // Send payment instructions to Discord user
            const callbackParam = encodeURIComponent(interaction.token);
            const paymentUrl = `${agentBaseUrl}/pay?channelId=${channel_id}&serverId=${guild_id || ""}&lookbackMinutes=${lookbackMinutes}&discord_callback=${callbackParam}`;
            
            // Get price from entrypoint config or default
            const price = process.env.ENTRYPOINT_PRICE || "0.10";
            const currency = process.env.PAYMENT_CURRENCY || "USDC";
            
            const paymentMessage = `💳 **Payment Required**

To summarise this channel, please pay **$${price} ${currency}** via x402.

🔗 **Pay & Summarise:** [Click here](${paymentUrl})

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

    // Decode the token (it was URL-encoded when passed in the payment URL)
    const decodedToken = decodeURIComponent(discord_token);
    
    const callbackData = pendingDiscordCallbacks.get(decodedToken);
    if (!callbackData) {
      console.error(`[discord-callback] Token not found or expired: ${decodedToken.substring(0, 30)}...`);
      return Response.json({ error: "Invalid or expired callback token" }, { status: 404 });
    }

    // Remove from pending
    pendingDiscordCallbacks.delete(decodedToken);

    // Send result to Discord
    const baseUrl = process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT_BASE;
    const followupUrl = `${baseUrl}/webhooks/${callbackData.applicationId}/${decodedToken}`;

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
    
    // Remove timestamps if they somehow got through
    summary = summary
      .replace(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/g, "") // ISO timestamps
      .replace(/\[[^\]]*\d{4}[^\]]*\]/g, "") // Any bracketed timestamps
      .replace(/x402 Summariser[^\n]*\n?/gi, "") // Remove "x402 Summariser:" prefix
      .trim();
    
    // If summary is empty or too short after filtering, use original
    if (!summary || summary.length < 10) {
      summary = output?.summary || "Summary generated successfully.";
    }
    
    let content = `✅ **Payment Confirmed**\n\n`;
    content += `${summary}\n\n`;
    
    if (output?.actionables && output.actionables.length > 0) {
      content += `**Action Items**\n${output.actionables.map((a: string, i: number) => `${i + 1}. ${a}`).join("\n")}`;
    } else {
      content += `*No action items identified.*`;
    }
    
    // Log payment verification info if available
    if (result?.payment || result?.x402Payment || result?.paymentTx) {
      const paymentInfo = result?.payment || result?.x402Payment || result?.paymentTx;
      console.log(`[payment] Payment verified:`, {
        txHash: paymentInfo.txHash || paymentInfo.hash || paymentInfo.transactionHash,
        from: paymentInfo.from || paymentInfo.sender || paymentInfo.payer,
        amount: paymentInfo.amount || paymentInfo.value,
        currency: paymentInfo.currency || paymentInfo.token || "USDC"
      });
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
      const lookbackMinutesParam = url.searchParams.get("lookbackMinutes");
      const discordCallback = url.searchParams.get("discord_callback");

      if (!channelId || lookbackMinutesParam === null) {
        return Response.json({ error: "Missing required parameters" }, { status: 400 });
      }

      const lookbackValidation = validateLookback(lookbackMinutesParam);
      if ("error" in lookbackValidation) {
        return Response.json({ error: lookbackValidation.error }, { status: 400 });
      }

      const { minutes: lookbackMinutes } = lookbackValidation;

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
  <script type="importmap">
    {
      "imports": {
        "x402-fetch": "https://esm.sh/x402-fetch@0.7.0?bundle",
        "x402/types": "https://esm.sh/x402@0.7.0/types?bundle",
        "x402/client": "https://esm.sh/x402@0.7.0/client?bundle",
        "x402/shared": "https://esm.sh/x402@0.7.0/shared?bundle",
        "viem": "https://esm.sh/viem@2.21.26?bundle",
        "viem/chains": "https://esm.sh/viem@2.21.26/chains?bundle"
      }
    }
  </script>
  <script type="module">
    let wrapFetchWithPayment;
    let createWalletClient;
    let custom;
    let base;
    let moduleLoaded = false;
    
    // Load x402-fetch and viem using import map (esm.sh with bundle flag handles dependencies)
    (async () => {
      try {
        const [x402Module, viemModule, chainsModule] = await Promise.all([
          import('x402-fetch'),
          import('viem'),
          import('viem/chains')
        ]);
        wrapFetchWithPayment = x402Module.wrapFetchWithPayment;
        createWalletClient = viemModule.createWalletClient;
        custom = viemModule.custom;
        base = chainsModule.base;
        
        if (wrapFetchWithPayment && createWalletClient && custom && base) {
          console.log('✅ x402-fetch and viem loaded successfully');
          moduleLoaded = true;
        } else {
          console.error('❌ Missing exports. wrapFetchWithPayment:', !!wrapFetchWithPayment, 'createWalletClient:', !!createWalletClient, 'custom:', !!custom, 'base:', !!base);
        }
      } catch (importError) {
        console.error('❌ Failed to import modules:', importError);
        console.error('Error details:', importError.message);
      }
    })();
    
    async function pay() {
      const status = document.getElementById('status');
      
      // Wait a bit for module to load if it hasn't yet
      if (!moduleLoaded && !wrapFetchWithPayment) {
        status.innerHTML = '<p>⏳ Loading payment library...</p>';
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      if (!wrapFetchWithPayment || !createWalletClient || !custom || !base) {
        status.innerHTML = '<p style="color: red;">⚠️ Error: Could not load payment libraries.</p><p style="font-size: 12px; color: #666;">Please refresh the page and try again.</p>';
        console.error('❌ Required modules not available. wrapFetchWithPayment:', !!wrapFetchWithPayment, 'createWalletClient:', !!createWalletClient);
        return;
      }
      
      status.innerHTML = '<p>🔌 Connecting wallet...</p>';
      
      try {
        // Check if window.ethereum (MetaMask) or other wallet is available
        if (typeof window.ethereum === 'undefined' && typeof window.x402 === 'undefined') {
          throw new Error('No wallet found. Please install MetaMask or an x402-compatible wallet extension.');
        }
        
        // Get wallet provider
        const walletProvider = window.ethereum || window.x402;
        
        // Request wallet connection (required for MetaMask)
        let accountAddress;
        if (walletProvider.request) {
          try {
            const accounts = await walletProvider.request({ method: 'eth_requestAccounts' });
            console.log('✅ Wallet connected');
            
            if (!accounts || accounts.length === 0) {
              throw new Error('No accounts found. Please unlock your wallet.');
            }
            
            accountAddress = accounts[0];
            
            // Ensure we're on Base network (required for payment)
            status.innerHTML = '<p>🔗 Checking network...</p>';
            const BASE_CHAIN_ID = 8453;
            const BASE_CHAIN_ID_HEX = '0x' + BASE_CHAIN_ID.toString(16);
            
            try {
              const currentChainIdHex = await walletProvider.request({ method: 'eth_chainId' });
              const currentChainId = parseInt(currentChainIdHex, 16);
              
              if (currentChainId !== BASE_CHAIN_ID) {
                status.innerHTML = '<p>⚠️ Switching to Base network...</p>';
                console.warn('⚠️ Wrong network. Current:', currentChainId, 'Required:', BASE_CHAIN_ID);
                
                try {
                  // Try to switch to Base network
                  await walletProvider.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: BASE_CHAIN_ID_HEX }],
                  });
                  status.innerHTML = '<p>✅ Switched to Base network</p>';
                } catch (switchError) {
                  // If the error is 4902, the chain is not added to MetaMask
                  if (switchError.code === 4902) {
                    console.warn('⚠️ Base network not found in wallet. Adding...');
                    status.innerHTML = '<p>➕ Adding Base network to wallet...</p>';
                    
                    await walletProvider.request({
                      method: 'wallet_addEthereumChain',
                      params: [{
                        chainId: BASE_CHAIN_ID_HEX,
                        chainName: 'Base',
                        nativeCurrency: {
                          name: 'Ethereum',
                          symbol: 'ETH',
                          decimals: 18
                        },
                        rpcUrls: ['https://mainnet.base.org'],
                        blockExplorerUrls: ['https://basescan.org']
                      }],
                    });
                  } else if (switchError.code === 4001) {
                    throw new Error('Network switch rejected. Please switch to Base network manually in MetaMask.');
                  } else {
                    throw new Error('Failed to switch network. Please switch to Base network manually in MetaMask.');
                  }
                }
              } else {
                status.innerHTML = '<p>✅ Already on Base network</p>';
              }
            } catch (networkError) {
              console.error('❌ Network check error:', networkError);
              throw new Error('Network error: ' + (networkError.message || 'Please ensure you are on Base network'));
            }
          } catch (connError) {
            if (connError.code === 4001) {
              throw new Error('Wallet connection rejected. Please approve the connection to continue.');
            }
            throw connError;
          }
        }
        
        // Create a viem wallet client (x402-fetch expects this format)
        const walletClient = createWalletClient({
          account: accountAddress,
          chain: base,
          transport: custom(walletProvider)
        });
        
        // Wrap fetch with payment handling (pass viem wallet client)
        // maxValue: 0.10 USDC = 100000 (6 decimals)
        // Note: x402 uses EIP-3009 for gasless transactions - facilitator pays gas
        const x402Fetch = wrapFetchWithPayment(fetch, walletClient, BigInt(100000));
        
        const entrypointUrl = '${entrypointUrl}';
        
        status.innerHTML = '<p>💳 Processing payment (gasless via facilitator)...</p>';
        
        // Check USDC balance before payment to verify transaction processing
        const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
        let balanceBefore = null;
        try {
          // ERC-20 balanceOf(address) - function selector: 0x70a08231
          const balanceData = await walletProvider.request({
            method: 'eth_call',
            params: [{
              to: USDC_ADDRESS,
              data: '0x70a08231' + accountAddress.slice(2).padStart(64, '0')
            }, 'latest']
          });
          balanceBefore = BigInt(balanceData);
        } catch (balanceError) {
          console.warn('⚠️ Could not check USDC balance:', balanceError);
        }
        
        // Log before the request to track when MetaMask should prompt
        console.log('⏳ Calling x402Fetch - MetaMask should prompt for EIP-3009 signature (not a transaction)...');
        console.log('📝 Note: x402 uses EIP-3009 permits - you are signing a message, not sending a transaction.');
        console.log('📝 The facilitator will process the permit and create a transaction.');
        
        let response;
        try {
          response = await x402Fetch(entrypointUrl, {
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
          
          // Check USDC balance after payment to verify transaction processed
          if (balanceBefore !== null) {
            try {
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for transaction to process
              const balanceDataAfter = await walletProvider.request({
                method: 'eth_call',
                params: [{
                  to: USDC_ADDRESS,
                  data: '0x70a08231' + accountAddress.slice(2).padStart(64, '0')
                }, 'latest']
              });
              const balanceAfter = BigInt(balanceDataAfter);
            } catch (balanceError) {
              console.warn('⚠️ Could not check USDC balance after payment:', balanceError);
            }
          }
        } catch (paymentError) {
          console.error('❌ Payment processing error:', paymentError);
          console.error('❌ Payment error details:', {
            message: paymentError.message,
            stack: paymentError.stack,
            name: paymentError.name,
            code: paymentError.code,
            data: paymentError.data
          });
          throw new Error('Payment failed: ' + (paymentError.message || 'Unknown error. Please check the console for details.'));
        }

        // Check for transaction hash in X-PAYMENT-RESPONSE header
        const paymentResponseHeader = response.headers.get('X-PAYMENT-RESPONSE');
        
        const data = await response.json();
        
        // Extract transaction hash from various possible locations
        let txHash = null;
        let explorerUrl = null;
        
        if (paymentResponseHeader) {
          try {
            const decodedHeader = window.atob(paymentResponseHeader);
            const paymentInfo = JSON.parse(decodedHeader);
            txHash = paymentInfo.txHash || paymentInfo.transactionHash || paymentInfo.hash;
          } catch (e) {
            console.warn('⚠️ Could not parse X-PAYMENT-RESPONSE header:', e);
          }
        }
        
        // Check in response data recursively
        if (!txHash && data.payment) {
          txHash = data.payment.txHash || data.payment.transactionHash || data.payment.hash;
        }
        
        if (!txHash && data.txHash) {
          txHash = data.txHash;
        }
        
        if (!txHash && data.transactionHash) {
          txHash = data.transactionHash;
        }
        
        // Check in nested locations (x402 might store it differently)
        if (!txHash && data.metadata && data.metadata.payment) {
          txHash = data.metadata.payment.txHash || data.metadata.payment.transactionHash || data.metadata.payment.hash;
        }
        
        if (!txHash && data.context && data.context.payment) {
          txHash = data.context.payment.txHash || data.context.payment.transactionHash || data.context.payment.hash;
        }
        
        // Check for any field containing "tx" or "hash"
        if (!txHash) {
          for (const key in data) {
            if (key.toLowerCase().includes('tx') || key.toLowerCase().includes('hash')) {
              const value = data[key];
              if (typeof value === 'string' && value.startsWith('0x')) {
                txHash = value;
                break;
              }
            }
          }
        }
        
        const successMarkup = (hash) => {
          if (!hash) {
            return '<div style="color: #117a39;">' +
              '<p style="font-size: 20px; margin: 0 0 8px;">✅ Payment complete!</p>' +
              '<p style="font-size: 13px; color: #1f5132; margin: 0;">Check Discord for your summary.</p>' +
              '</div>';
          }

          const explorer = 'https://basescan.org/tx/' + hash;
          return '<div style="color: #117a39;">' +
            '<p style="font-size: 20px; margin: 0 0 8px;">✅ Payment complete!</p>' +
            '<p style="margin: 0 0 12px;">View on BaseScan: <a href="' + explorer + '" target="_blank" rel="noopener" style="color: #0b5e27;">' + hash + '</a></p>' +
            '<p style="font-size: 13px; color: #1f5132; margin: 0;">Check Discord for your summary.</p>' +
            '</div>';
        };

        if (txHash) {
          console.log('✅ Transaction hash found:', txHash);
          status.innerHTML = successMarkup(txHash);
        } else {
          status.innerHTML = successMarkup(null);
        }
        
        if (response.ok) {
          
          ${discordCallback ? 'fetch(\'/discord-callback\', {' +
            'method: \'POST\',' +
            'headers: { \'Content-Type\': \'application/json\' },' +
            'body: JSON.stringify({' +
            'discord_token: \'' + discordCallback + '\',' +
            'result: data' +
            '})' +
            '}).catch(function(err) {' +
            'console.error(\'❌ Callback error:\', err);' +
            'status.innerHTML += \'<p style="color: orange;">⚠️ Payment successful but failed to send to Discord. Please contact support.</p>\';' +
            '});' : ''}
        } else if (response.status === 402) {
          status.innerHTML = '<p style="color: orange;">💳 Payment required. Please connect your x402 wallet and approve the transaction.</p>';
        } else {
          const errorMsg = data.error ? (data.error.message || JSON.stringify(data)) : JSON.stringify(data);
          status.innerHTML = '<p style="color: red;">❌ Error: ' + errorMsg + '</p>';
        }
      } catch (error) {
        console.error('❌ Payment error:', error);
        status.innerHTML = '<p style="color: red;">❌ Error: ' + error.message + '</p>';
        if (error.message.includes('wallet') || error.message.includes('user rejected') || error.message.includes('User rejected')) {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Make sure you have an x402 wallet browser extension installed and approved the transaction.</p>';
        } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Network error. Please check your connection and try again.</p>';
        } else {
          status.innerHTML += '<p style="font-size: 12px; color: #666;">Check browser console (F12) for more details.</p>';
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
      const isSummariseEntrypoint =
        url.pathname.includes("summarise%20chat") || url.pathname.includes("summarise chat");
      if (isSummariseEntrypoint) {
        const hasPaymentHeader = req.headers.get("X-PAYMENT");
        console.log(`[payment] Entrypoint called: ${url.pathname}`);

        const payToAddress =
          process.env.PAY_TO || "0x1b0006DbFbF4d8Ec99cd7C40C43566EaA7D95feD";
        const facilitatorUrl =
          process.env.FACILITATOR_URL || "https://facilitator.x402.rs";
        const agentBaseUrl =
          process.env.AGENT_URL || `https://x402-summariser-production.up.railway.app`;
        const fullEntrypointUrl =
          agentBaseUrl + url.pathname + (url.search ? url.search : "");
        const price = process.env.ENTRYPOINT_PRICE || "0.10";
        const currency = process.env.PAYMENT_CURRENCY || "USDC";
        const x402Version = 1.0;

        const paymentRequirement = {
          scheme: "exact" as const,
          resource: fullEntrypointUrl,
          description: `Summarise Discord channel - Pay $${price} ${currency}`,
          mimeType: "application/json",
          payTo: payToAddress,
          maxAmountRequired: "100000",
          maxTimeoutSeconds: 300,
          network: "base" as const,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          extra: {
            name: "USD Coin",
            version: "2",
          },
        };
        const paymentRequirements = [paymentRequirement];

        if (!hasPaymentHeader) {
          console.log(`[payment] Returning 402 Payment Required for: ${fullEntrypointUrl}`);
          return Response.json(
            {
              x402Version,
              accepts: paymentRequirements,
            },
            { status: 402 }
          );
        }

        let decodedPayment;
        try {
          decodedPayment = exact.evm.decodePayment(hasPaymentHeader);
          decodedPayment.x402Version = x402Version;
        } catch (error) {
          console.error("[payment] Failed to decode X-PAYMENT header", error);
          return Response.json(
            {
              error: "Invalid or malformed payment header",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        const selectedPaymentRequirements = findMatchingPaymentRequirements(
          paymentRequirements,
          decodedPayment
        );

        if (!selectedPaymentRequirements) {
          console.error("[payment] Unable to match payment requirements", decodedPayment);
          return Response.json(
            {
              error: "Unable to match payment requirements",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        const facilitatorClient = useFacilitator({
          url: facilitatorUrl as `${string}://${string}`,
        });
        let verification;
        try {
          verification = await facilitatorClient.verify(
            decodedPayment,
            selectedPaymentRequirements
          );
        } catch (error) {
          console.error("[payment] Facilitator verification error", error);
          return Response.json(
            {
              error: "Failed to verify payment",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        if (!verification.isValid) {
          console.error("[payment] Payment verification failed", verification);
          return Response.json(
            {
              error: verification.invalidReason || "Payment verification failed",
              accepts: paymentRequirements,
              payer: verification.payer,
              x402Version,
            },
            { status: 402 }
          );
        }

        const appResponse = await app.fetch(req);

        if (appResponse.status >= 400) {
          return appResponse;
        }

        const appResponseClone = appResponse.clone();
        let settlement;
        try {
          settlement = await facilitatorClient.settle(
            decodedPayment,
            selectedPaymentRequirements
          );
        } catch (error) {
          console.error("[payment] Facilitator settlement error", error);
          return Response.json(
            {
              error: "Failed to settle payment",
              accepts: paymentRequirements,
              x402Version,
            },
            { status: 402 }
          );
        }

        if (!settlement.success) {
          console.error("[payment] Settlement failed", settlement);
          return Response.json(
            {
              error: settlement.errorReason || "Failed to settle payment",
              accepts: paymentRequirements,
              payer: settlement.payer,
              x402Version,
            },
            { status: 402 }
          );
        }

        const settlementHeader = settleResponseHeader(settlement);
        console.log(`[payment] Settlement succeeded:`, settlement);

        const headers = new Headers(appResponse.headers);
        headers.set("X-PAYMENT-RESPONSE", settlementHeader);
        const responseWithHeader = new Response(appResponse.body, {
          status: appResponse.status,
          statusText: appResponse.statusText,
          headers,
        });

        const discordCallback = url.searchParams.get("discord_callback");

        if (discordCallback) {
          if (appResponseClone.status >= 200 && appResponseClone.status < 300) {
            try {
              const result = await appResponseClone.json();
              const serverHost = process.env.AGENT_URL
                ? new URL(process.env.AGENT_URL).origin
                : url.origin;
              const callbackUrl = `${serverHost}/discord-callback`;

              console.log(`[discord] Triggering callback to: ${callbackUrl}`);

              const callbackResponse = await fetch(callbackUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  discord_token: decodeURIComponent(discordCallback),
                  result,
                }),
              });

              if (!callbackResponse.ok) {
                const errorText = await callbackResponse.text();
                console.error(
                  `[discord] Callback failed: ${callbackResponse.status} ${errorText}`
                );
                console.error(`[discord] Callback URL was: ${callbackUrl}`);
              } else {
                console.log(`[discord] Callback successful`);
              }
            } catch (err) {
              console.error("[discord] Failed to parse entrypoint response:", err);
            }
          }

          return responseWithHeader;
        }

        return responseWithHeader;
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
