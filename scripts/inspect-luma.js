/**
 * Script to inspect luma.com/discover page structure
 * Run with: node scripts/inspect-luma.js
 * 
 * This will help us understand:
 * 1. How events are loaded (API endpoints, JSON data)
 * 2. The structure of event data
 * 3. How search/filtering works
 */

// Note: This is a guide script - you'll need to run this in a browser console
// or use Puppeteer/Playwright to actually inspect the page

console.log(`
=== Luma.com/Discover Inspection Guide ===

To inspect luma.com/discover, follow these steps:

1. Open luma.com/discover in your browser
2. Open Developer Tools (F12 or Cmd+Option+I)
3. Go to the Network tab
4. Filter by "XHR" or "Fetch" to see API calls
5. Look for:
   - JSON endpoints that load event data
   - Search/filter parameters in URLs
   - Request headers and payloads

What to look for:
- Endpoints like: /api/events, /v1/events, /discover/events, etc.
- Query parameters for location/topic filtering
- Response structure (event IDs, titles, URLs, dates, locations)

Common patterns to check:
- /api/discover/events?location=...
- /api/events/search?q=...
- GraphQL endpoints
- WebSocket connections for real-time updates

Once you find the endpoint, note:
- Base URL
- Required headers
- Query parameters
- Response format
- Rate limiting headers

=== Alternative: Use Puppeteer ===

If you want to automate this inspection, we can create a Puppeteer script
that will:
1. Load luma.com/discover
2. Intercept network requests
3. Log all API calls
4. Extract event data structure
`);

// If you want to run this with Puppeteer, uncomment below:
/*
import puppeteer from 'puppeteer';

async function inspectLuma() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  // Intercept network requests
  page.on('request', request => {
    const url = request.url();
    if (url.includes('api') || url.includes('events') || url.includes('discover')) {
      console.log('REQUEST:', request.method(), url);
      console.log('Headers:', request.headers());
      console.log('Post Data:', request.postData());
    }
  });
  
  page.on('response', response => {
    const url = response.url();
    if (url.includes('api') || url.includes('events') || url.includes('discover')) {
      console.log('RESPONSE:', response.status(), url);
      response.json().then(data => {
        console.log('Response Data:', JSON.stringify(data, null, 2));
      }).catch(() => {
        response.text().then(text => {
          console.log('Response Text:', text.substring(0, 500));
        });
      });
    }
  });
  
  await page.goto('https://luma.com/discover', { waitUntil: 'networkidle2' });
  
  // Wait a bit to capture all requests
  await page.waitForTimeout(5000);
  
  // Try to find event elements
  const events = await page.evaluate(() => {
    // Look for common event container selectors
    const selectors = [
      '[data-testid*="event"]',
      '.event-card',
      '[class*="Event"]',
      '[class*="event"]',
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        return Array.from(elements).slice(0, 3).map(el => ({
          html: el.outerHTML.substring(0, 200),
          text: el.textContent?.substring(0, 100),
        }));
      }
    }
    return null;
  });
  
  console.log('Found event elements:', events);
  
  await browser.close();
}

inspectLuma().catch(console.error);
*/

