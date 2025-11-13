/**
 * Luma event search functionality
 * 
 * This module handles searching for events on Luma.com using their public API
 * API endpoints discovered:
 * - Topics: https://api2.luma.com/url?url=<topic-slug>
 * - Places: https://api2.luma.com/discover/bootstrap-page?featured_place_api_id=<place-id>
 */

export type LumaSearchParams = {
  query: string;
  searchType: "place" | "topic";
  limit?: number;
};

export type LumaEvent = {
  id: string;
  title: string;
  url: string;
  description?: string;
  location?: string;
  date?: string;
  calendarName?: string;
  eventApiId?: string; // For fetching individual event details if needed
};

type LumaCalendar = {
  api_id: string;
  calendar: {
    name: string;
    slug: string;
    api_id: string;
    website?: string;
    geo_city?: string;
    geo_region?: string;
    geo_country?: string;
    description_short?: string;
  };
  event_count: number;
  start_at?: string;
  end_at?: string;
};

type LumaTopicResponse = {
  kind: string;
  data: {
    category?: {
      name: string;
      slug: string;
      event_count: number;
    };
    timeline_calendars: LumaCalendar[];
    num_upcoming_events?: number;
  };
};

type LumaPlaceResponse = {
  // TODO: We need to inspect the bootstrap-page response structure
  // For now, we'll handle it similarly
  [key: string]: any;
};

/**
 * Normalize query to slug format (lowercase, spaces to hyphens, etc.)
 */
function normalizeToSlug(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/**
 * Build Luma event URL from calendar slug
 */
function buildEventUrl(calendarSlug: string): string {
  return `https://lu.ma/${calendarSlug}`;
}

/**
 * Convert Luma calendar to LumaEvent
 */
function calendarToEvent(calendar: LumaCalendar, index: number): LumaEvent {
  const locationParts = [
    calendar.calendar.geo_city,
    calendar.calendar.geo_region,
    calendar.calendar.geo_country,
  ].filter(Boolean);
  
  return {
    id: calendar.api_id || `event-${index}`,
    title: calendar.calendar.name,
    url: buildEventUrl(calendar.calendar.slug),
    description: calendar.calendar.description_short,
    location: locationParts.length > 0 ? locationParts.join(", ") : undefined,
    date: calendar.start_at || undefined,
    calendarName: calendar.calendar.name,
  };
}

/**
 * Search for events by topic using Luma API
 */
async function searchByTopic(query: string, limit: number): Promise<LumaEvent[]> {
  const slug = normalizeToSlug(query);
  const url = `https://api2.luma.com/url?url=${encodeURIComponent(slug)}`;
  
  console.log(`[luma] Searching topic: ${slug} via ${url}`);
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (!response.ok) {
      console.error(`[luma] Topic search failed: ${response.status} ${response.statusText}`);
      return [];
    }
    
    const data: LumaTopicResponse = await response.json();
    
    if (data.kind !== "category" || !data.data.timeline_calendars) {
      console.log(`[luma] No category data found for topic: ${query}`);
      return [];
    }
    
    // Extract calendars (which represent event series/calendars)
    const calendars = data.data.timeline_calendars
      .filter(cal => cal.event_count > 0) // Only include calendars with events
      .slice(0, limit);
    
    const events = calendars.map((cal, idx) => calendarToEvent(cal, idx));
    
    console.log(`[luma] Found ${events.length} calendars/events for topic: ${query}`);
    return events;
  } catch (error) {
    console.error(`[luma] Error searching topic "${query}":`, error);
    return [];
  }
}

/**
 * Fetch individual event details to get location information
 */
async function getEventDetails(eventApiId: string): Promise<any> {
  const url = `https://api2.luma.com/event/get?event_api_id=${eventApiId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (!response.ok) {
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error(`[luma] Error fetching event details for ${eventApiId}:`, error);
    return null;
  }
}

/**
 * Extract location from event data
 */
function extractLocationFromEvent(eventData: any): string | undefined {
  if (!eventData) return undefined;
  
  // Try various location fields
  const locationFields = [
    eventData.location,
    eventData.venue?.name,
    eventData.venue?.address,
    eventData.geo_city,
    eventData.geo_region,
    eventData.geo_country,
    eventData.address,
    eventData.place?.name,
    eventData.coordinate,
  ];
  
  // Build location string from available fields
  const parts: string[] = [];
  
  if (eventData.geo_city) parts.push(eventData.geo_city);
  if (eventData.geo_region && eventData.geo_region !== eventData.geo_city) {
    parts.push(eventData.geo_region);
  }
  if (eventData.geo_country) parts.push(eventData.geo_country);
  
  if (parts.length > 0) {
    return parts.join(", ");
  }
  
  // Fallback to other fields
  for (const field of locationFields) {
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }
  
  return undefined;
}

/**
 * Search for events by place using Luma API
 * 
 * Since Luma doesn't support direct location search, we:
 * 1. Try searching the place name as a topic (some cities have topic pages)
 * 2. If that doesn't work, return a helpful message
 * 
 * Note: We could potentially search by topic and then filter by location
 * if we fetch individual event details, but that would be slow and hit rate limits.
 */
async function searchByPlace(query: string, limit: number): Promise<LumaEvent[]> {
  // Approach: Try searching the place name as a topic
  // Some cities might have topic/category pages (e.g., "san-francisco")
  const slug = normalizeToSlug(query);
  const urlEndpoint = `https://api2.luma.com/url?url=${encodeURIComponent(slug)}`;
  
  console.log(`[luma] Searching place as topic: ${query} via ${urlEndpoint}`);
  
  try {
    const response = await fetch(urlEndpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    
    if (response.ok) {
      const data: LumaTopicResponse = await response.json();
      
      // Check if it returned category/calendar data
      if (data.data?.timeline_calendars) {
        const calendars = data.data.timeline_calendars
          .filter(cal => cal.event_count > 0)
          .slice(0, limit);
        
        const events = calendars.map((cal, idx) => calendarToEvent(cal, idx));
        
        if (events.length > 0) {
          console.log(`[luma] Found ${events.length} events for place (as topic): ${query}`);
          return events;
        }
      }
    }
  } catch (error) {
    console.error(`[luma] Error searching place "${query}":`, error);
  }
  
  // If no results, return empty array
  // The user will see "No events found" message
  console.log(`[luma] No events found for place: ${query}`);
  return [];
}

/**
 * Search for events on Luma
 * 
 * @param params Search parameters
 * @returns Array of event links and details
 */
export async function searchLumaEvents(params: LumaSearchParams): Promise<LumaEvent[]> {
  const { query, searchType, limit = 10 } = params;
  
  console.log(`[luma] Searching for events: type=${searchType}, query="${query}", limit=${limit}`);
  
  if (searchType === "topic") {
    return await searchByTopic(query, limit);
  } else {
    return await searchByPlace(query, limit);
  }
}

/**
 * Format events as a list of links for Telegram
 */
export function formatEventsForTelegram(events: LumaEvent[]): string {
  if (events.length === 0) {
    return "No events found. Please try a different search query.";
  }
  
  const lines = events.map((event, index) => {
    const num = index + 1;
    const title = event.title || "Untitled Event";
    const url = event.url;
    
    // Add location or description if available
    let details = "";
    if (event.location) {
      details = ` - ${event.location}`;
    } else if (event.description) {
      const desc = event.description.length > 50 
        ? event.description.substring(0, 47) + "..."
        : event.description;
      details = ` - ${desc}`;
    }
    
    return `${num}. [${title}](${url})${details}`;
  });
  
  return `Found ${events.length} event${events.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}`;
}

