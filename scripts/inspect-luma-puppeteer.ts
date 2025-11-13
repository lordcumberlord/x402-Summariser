/**
 * Puppeteer script to inspect luma.com/discover
 * 
 * Install dependencies:
 *   bun add puppeteer
 * 
 * Run with:
 *   bun run scripts/inspect-luma-puppeteer.ts
 */

import puppeteer from 'puppeteer';

interface NetworkRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
}

interface NetworkResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

const requests: NetworkRequest[] = [];
const responses: NetworkResponse[] = [];

async function inspectLuma() {
  console.log('🚀 Launching browser...');
  const browser = await puppeteer.launch({ 
    headless: false, // Set to true to run in background
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  
  // Intercept network requests
  page.on('request', request => {
    const url = request.url();
    // Look for API calls, JSON endpoints, or event-related URLs
    if (
      url.includes('api') || 
      url.includes('events') || 
      url.includes('discover') ||
      url.includes('luma.com') && (url.endsWith('.json') || url.includes('/v1/') || url.includes('/v2/'))
    ) {
      const req: NetworkRequest = {
        method: request.method(),
        url: url,
        headers: request.headers(),
        postData: request.postData() || undefined,
      };
      requests.push(req);
      console.log('\n📤 REQUEST:', request.method(), url);
      if (request.postData()) {
        console.log('   Post Data:', request.postData()?.substring(0, 200));
      }
    }
  });
  
  // Intercept network responses
  page.on('response', async response => {
    const url = response.url();
    if (
      url.includes('api') || 
      url.includes('events') || 
      url.includes('discover') ||
      url.includes('luma.com') && (url.endsWith('.json') || url.includes('/v1/') || url.includes('/v2/'))
    ) {
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      
      let body: any = null;
      try {
        if (contentType.includes('application/json')) {
          body = await response.json();
        } else if (contentType.includes('text/')) {
          const text = await response.text();
          body = text.substring(0, 1000); // First 1000 chars
        }
      } catch (e) {
        // Ignore parsing errors
      }
      
      const resp: NetworkResponse = {
        status: response.status(),
        url: url,
        headers: headers,
        body: body,
      };
      responses.push(resp);
      
      console.log('\n📥 RESPONSE:', response.status(), url);
      if (body) {
        if (typeof body === 'object') {
          console.log('   Body:', JSON.stringify(body, null, 2).substring(0, 500));
        } else {
          console.log('   Body:', body.substring(0, 500));
        }
      }
    }
  });
  
  console.log('🌐 Navigating to luma.com/discover...');
  await page.goto('https://luma.com/discover', { 
    waitUntil: 'networkidle2',
    timeout: 30000 
  });
  
  console.log('⏳ Waiting for page to load...');
  await page.waitForTimeout(5000);
  
  // Try to interact with search/filter if it exists
  console.log('🔍 Looking for search/filter elements...');
  try {
    // Common selectors for search inputs
    const searchSelectors = [
      'input[type="search"]',
      'input[placeholder*="search" i]',
      'input[placeholder*="location" i]',
      'input[placeholder*="topic" i]',
      '[data-testid*="search"]',
    ];
    
    for (const selector of searchSelectors) {
      const element = await page.$(selector);
      if (element) {
        console.log(`   Found search element: ${selector}`);
        // Try typing to see what API calls it triggers
        await element.type('San Francisco', { delay: 100 });
        await page.waitForTimeout(2000);
        await element.click({ clickCount: 3 }); // Select all
        await page.keyboard.press('Backspace'); // Clear
        break;
      }
    }
  } catch (e) {
    console.log('   No search element found or error:', e);
  }
  
  // Extract page structure
  console.log('\n📄 Extracting page structure...');
  const pageInfo = await page.evaluate(() => {
    // Look for event containers
    const eventSelectors = [
      '[data-testid*="event"]',
      '[class*="Event"]',
      '[class*="event"]',
      'article',
      '[role="article"]',
    ];
    
    const foundEvents: any[] = [];
    
    for (const selector of eventSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        Array.from(elements).slice(0, 5).forEach((el, idx) => {
          const links = el.querySelectorAll('a[href*="lu.ma"]');
          const text = el.textContent?.trim().substring(0, 200);
          foundEvents.push({
            selector,
            index: idx,
            hasLinks: links.length > 0,
            linkHrefs: Array.from(links).map(a => (a as HTMLAnchorElement).href).slice(0, 3),
            textPreview: text,
            htmlPreview: el.outerHTML.substring(0, 300),
          });
        });
        break; // Use first selector that finds elements
      }
    }
    
    // Check for JSON data in script tags
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
    const jsonData = scripts.map(script => {
      try {
        return JSON.parse(script.textContent || '');
      } catch {
        return null;
      }
    }).filter(Boolean);
    
    return {
      title: document.title,
      url: window.location.href,
      foundEvents,
      jsonDataInScripts: jsonData.length > 0,
      jsonDataPreview: jsonData.length > 0 ? JSON.stringify(jsonData[0], null, 2).substring(0, 500) : null,
    };
  });
  
  console.log('\n📊 Page Info:');
  console.log(JSON.stringify(pageInfo, null, 2));
  
  console.log('\n📋 Summary:');
  console.log(`   Total API requests captured: ${requests.length}`);
  console.log(`   Total API responses captured: ${responses.length}`);
  
  // Find the most promising endpoint
  const eventEndpoints = responses.filter(r => 
    r.body && 
    typeof r.body === 'object' && 
    (Array.isArray(r.body) || r.body.events || r.body.data)
  );
  
  if (eventEndpoints.length > 0) {
    console.log('\n✅ Found potential event data endpoints:');
    eventEndpoints.forEach((resp, idx) => {
      console.log(`   ${idx + 1}. ${resp.url} (${resp.status})`);
    });
  } else {
    console.log('\n⚠️  No obvious event data endpoints found in JSON responses');
    console.log('   Events might be rendered server-side or use a different format');
  }
  
  // Save results to file
  const results = {
    timestamp: new Date().toISOString(),
    requests,
    responses,
    pageInfo,
  };
  
  await Bun.write(
    'luma-inspection-results.json',
    JSON.stringify(results, null, 2)
  );
  
  console.log('\n💾 Results saved to luma-inspection-results.json');
  
  await browser.close();
  console.log('\n✅ Inspection complete!');
}

inspectLuma().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});

