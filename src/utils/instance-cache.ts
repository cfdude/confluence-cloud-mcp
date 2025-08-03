import type { InstanceConfig } from '../config.js';

interface CacheEntry {
  instanceName: string;
  spaceKey: string;
  timestamp: number;
}

// Page ID to instance mapping cache
const pageInstanceCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get cached instance for a page ID
 */
export async function getInstanceForPageId(
  pageId: string
): Promise<{ instanceName: string; config: InstanceConfig } | null> {
  const entry = pageInstanceCache.get(pageId);

  if (!entry) return null;

  // Check if cache entry is expired
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    pageInstanceCache.delete(pageId);
    return null;
  }

  // Load config and return instance
  const { loadMultiInstanceConfig } = await import('../config.js');
  const config = await loadMultiInstanceConfig();
  const instanceConfig = config.instances[entry.instanceName];

  if (!instanceConfig) {
    // Instance no longer exists in config
    pageInstanceCache.delete(pageId);
    return null;
  }

  return {
    instanceName: entry.instanceName,
    config: instanceConfig,
  };
}

/**
 * Cache page to instance mapping
 */
export async function cachePageInstance(
  pageId: string,
  spaceKey: string,
  instanceName: string
): Promise<void> {
  pageInstanceCache.set(pageId, {
    instanceName,
    spaceKey,
    timestamp: Date.now(),
  });

  // Cleanup old entries periodically
  cleanupCache();
}

/**
 * Clear specific page from cache
 */
export function clearPageCache(pageId: string): void {
  pageInstanceCache.delete(pageId);
}

/**
 * Clear entire cache
 */
export function clearAllCache(): void {
  pageInstanceCache.clear();
}

/**
 * Cleanup expired cache entries
 */
let lastCleanup = 0;
function cleanupCache(): void {
  // Only cleanup every 5 minutes
  if (Date.now() - lastCleanup < 5 * 60 * 1000) return;

  lastCleanup = Date.now();
  const now = Date.now();

  for (const [pageId, entry] of pageInstanceCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      pageInstanceCache.delete(pageId);
    }
  }
}

/**
 * Get cache statistics (useful for debugging)
 */
export function getCacheStats(): {
  size: number;
  entries: Array<{ pageId: string; instanceName: string; age: number }>;
} {
  const now = Date.now();
  const entries = Array.from(pageInstanceCache.entries()).map(([pageId, entry]) => ({
    pageId,
    instanceName: entry.instanceName,
    age: Math.floor((now - entry.timestamp) / 1000), // age in seconds
  }));

  return {
    size: pageInstanceCache.size,
    entries,
  };
}
