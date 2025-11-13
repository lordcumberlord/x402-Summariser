/**
 * Quick test script for Luma search functionality
 * Run with: bun run test-luma.ts
 */

import { searchLumaEvents, formatEventsForTelegram } from "./src/luma";

async function test() {
  console.log("=".repeat(60));
  console.log("Testing Luma Event Search");
  console.log("=".repeat(60));
  
  // Test 1: Topic search - crypto
  console.log("\n📋 Test 1: Topic search for 'crypto'\n");
  try {
    const cryptoEvents = await searchLumaEvents({
      query: "crypto",
      searchType: "topic",
      limit: 5
    });
    
    console.log(`✅ Found ${cryptoEvents.length} events\n`);
    if (cryptoEvents.length > 0) {
      console.log(formatEventsForTelegram(cryptoEvents));
    } else {
      console.log("❌ No events found");
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
  
  // Test 2: Topic search - AI
  console.log("\n" + "=".repeat(60));
  console.log("\n📋 Test 2: Topic search for 'AI'\n");
  try {
    const aiEvents = await searchLumaEvents({
      query: "AI",
      searchType: "topic",
      limit: 5
    });
    
    console.log(`✅ Found ${aiEvents.length} events\n`);
    if (aiEvents.length > 0) {
      console.log(formatEventsForTelegram(aiEvents));
    } else {
      console.log("❌ No events found");
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
  
  // Test 3: Place search - San Francisco (limited support)
  console.log("\n" + "=".repeat(60));
  console.log("\n📋 Test 3: Place search for 'San Francisco' (limited)\n");
  try {
    const sfEvents = await searchLumaEvents({
      query: "San Francisco",
      searchType: "place",
      limit: 5
    });
    
    console.log(`✅ Found ${sfEvents.length} events\n`);
    if (sfEvents.length > 0) {
      console.log(formatEventsForTelegram(sfEvents));
    } else {
      console.log("⚠️  No events found (place search has limited support)");
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("✅ Tests complete!");
  console.log("=".repeat(60));
}

test().catch(console.error);

