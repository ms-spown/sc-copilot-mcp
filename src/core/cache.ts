import type { AxiosRequestConfig } from "axios";
import type { HttpClient } from "./http.js";

const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** GET through a short in-memory cache keyed by base URL, path and query parameters. */
export async function fetchWithCache(client: HttpClient, url: string, config?: AxiosRequestConfig) {
  const cacheKey = (client.defaults?.baseURL || "") + url + JSON.stringify(config?.params || {});
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.error(`[Cache Hit] ${cacheKey}`);
    return { data: cached.data };
  }

  console.error(`[Cache Miss] ${cacheKey}`);
  const response = await client.get(url, config);
  cache.set(cacheKey, { data: response.data, timestamp: Date.now() });
  return { data: response.data };
}

/** Empty the cache. Used by tests; the server never needs it. */
export function clearCache(): void {
  cache.clear();
}
