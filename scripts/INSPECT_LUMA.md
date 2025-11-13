# Inspecting luma.com/discover

This guide will help you understand how luma.com/discover loads and displays events, so we can implement the search functionality.

## Option 1: Manual Browser Inspection (Recommended First Step)

1. **Open luma.com/discover in your browser**
   - Go to https://luma.com/discover

2. **Open Developer Tools**
   - Chrome/Edge: Press `F12` or `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows)
   - Firefox: Press `F12` or `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows)

3. **Go to Network Tab**
   - Click on the "Network" tab in DevTools
   - Make sure "Preserve log" is checked
   - Filter by "XHR" or "Fetch" to see API calls

4. **Reload the page**
   - Press `Cmd+R` (Mac) / `Ctrl+R` (Windows) to reload
   - Watch for network requests

5. **Look for these patterns:**
   - URLs containing: `api`, `events`, `discover`, `search`
   - JSON responses (check the "Response" tab)
   - Query parameters like `?location=`, `?q=`, `?topic=`

6. **Try searching/filtering:**
   - If there's a search box, type something
   - If there are location filters, click them
   - Watch what network requests are triggered

7. **Document what you find:**
   - Copy the endpoint URL
   - Note the request method (GET/POST)
   - Check request headers
   - Look at the response structure
   - Note any query parameters

## Option 2: Automated Inspection with Puppeteer

1. **Install Puppeteer:**
   ```bash
   bun add -d puppeteer
   ```

2. **Run the inspection script:**
   ```bash
   bun run scripts/inspect-luma-puppeteer.ts
   ```

3. **Review the results:**
   - The script will log all API calls to the console
   - Results are saved to `luma-inspection-results.json`

## What to Look For

### Ideal Scenario:
- **JSON API endpoint** that returns event data
- **Search parameters** in the URL (e.g., `?location=San+Francisco`)
- **Simple GET request** we can replicate
- **No authentication required** for public events

### Example of what we're hoping to find:
```
GET https://luma.com/api/v1/discover/events?location=San+Francisco
Response: {
  "events": [
    {
      "id": "...",
      "title": "...",
      "url": "https://lu.ma/event-id",
      "location": "...",
      "date": "..."
    }
  ]
}
```

### If we find GraphQL:
- Look for the GraphQL endpoint
- Note the query structure
- We can replicate the query in our code

### If it's server-side rendered:
- Events are in the HTML
- We'll need to parse HTML with selectors
- May need to handle pagination

## Next Steps

Once you've identified how events are loaded:

1. **Share the findings** (endpoint URL, request format, response structure)
2. **We'll implement** the search function in `src/luma.ts`
3. **Test** with a few queries to make sure it works

## Common Issues

- **CORS errors**: If the API blocks cross-origin requests, we may need a proxy
- **Rate limiting**: We'll implement caching to respect limits
- **Dynamic content**: If events load via JavaScript, we may need Puppeteer
- **Authentication**: If public events require auth, we'll need to handle that

