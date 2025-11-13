/**
 * Quick script to test the individual event API
 * Run with: bun run scripts/test-event-api.ts
 */

const eventApiId = "evt-eJfPbbsOOZ3p6mv";
const url = `https://api2.luma.com/event/get?event_api_id=${eventApiId}`;

console.log(`Testing event API: ${url}\n`);

try {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    console.error(`Error: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const data = await response.json();
  
  console.log("Full response structure:");
  console.log(JSON.stringify(data, null, 2));
  
  // Look for location-related fields
  console.log("\n=== Location-related fields ===");
  const locationFields = findLocationFields(data);
  console.log(JSON.stringify(locationFields, null, 2));
  
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}

function findLocationFields(obj: any, path = ""): any {
  const locationKeys = ["location", "geo", "city", "address", "venue", "place", "coordinates", "lat", "lng", "longitude", "latitude"];
  const result: any = {};
  
  if (typeof obj !== "object" || obj === null) {
    return null;
  }
  
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    const lowerKey = key.toLowerCase();
    
    // Check if this key is location-related
    if (locationKeys.some(locKey => lowerKey.includes(locKey))) {
      result[currentPath] = value;
    }
    
    // Recursively search nested objects
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = findLocationFields(value, currentPath);
      if (nested && Object.keys(nested).length > 0) {
        Object.assign(result, nested);
      }
    } else if (Array.isArray(value)) {
      // Check array items
      value.forEach((item, idx) => {
        if (typeof item === "object" && item !== null) {
          const nested = findLocationFields(item, `${currentPath}[${idx}]`);
          if (nested && Object.keys(nested).length > 0) {
            Object.assign(result, nested);
          }
        }
      });
    }
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

