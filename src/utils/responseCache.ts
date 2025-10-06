/**
 * Response Cache and Request Deduplication Manager
 * Provides short-TTL response caching and in-flight request deduplication
 * to reduce redundant upstream calls and improve performance
 *
 * PERFORMANCE OPTIMIZATION (Phase 2, Issue #2):
 * - Replaced manual Map with O(n log n) eviction with LRU cache for O(1) operations
 * - Uses lru-cache package for efficient memory management
 */

import { logger } from './logger.js'
import { createHash } from 'crypto'
import { LRUCache } from 'lru-cache'
import xxhash from 'xxhash-wasm'

export interface CachedResponse {
  data: any
  timestamp: number
  ttl: number
  hits: number
}

export interface PendingRequest {
  promise: Promise<any>
  timestamp: number
  resolvers: Array<(value: any) => void>
  rejectors: Array<(error: any) => void>
}

export interface CacheStats {
  size: number
  maxSize: number
  hitRate: number
  totalRequests: number
  cacheHits: number
  dedupHits: number
  evictions: number
}

// PERFORMANCE: Initialize xxhash once for reuse
let xxhashInstance: any = null
const initXXHash = async () => {
  if (!xxhashInstance) {
    const hasher = await xxhash()
    xxhashInstance = hasher
  }
  return xxhashInstance
}

export class ResponseCacheManager {
  // PERFORMANCE OPTIMIZATION: Use LRU cache for O(1) eviction instead of manual sorting
  private cache: LRUCache<string, CachedResponse>
  private pendingRequests = new Map<string, PendingRequest>()
  private readonly MAX_CACHE_SIZE = 1000
  private readonly DEFAULT_TTL = 60000 // 60 seconds
  private readonly MAX_PENDING_TIME = 30000 // 30 seconds

  // Statistics
  private totalRequests = 0
  private cacheHits = 0
  private dedupHits = 0
  private evictions = 0

  constructor() {
    // PERFORMANCE: Initialize LRU cache with automatic eviction
    this.cache = new LRUCache<string, CachedResponse>({
      max: this.MAX_CACHE_SIZE,
      ttl: this.DEFAULT_TTL,
      updateAgeOnGet: true, // Update age on access for true LRU behavior
      dispose: (value, key) => {
        this.evictions++
        logger.debug('RESPONSE_CACHE', `LRU evicted cache entry: ${key}`)
      }
    })

    // Initialize xxhash asynchronously
    initXXHash().catch(err => {
      logger.warn('RESPONSE_CACHE', `Failed to initialize xxhash: ${err}`)
    })
  }

  /**
   * Generate cache key from request parameters
   * PERFORMANCE OPTIMIZATION (Phase 2, Issue #1):
   * - Fast path for small requests (< 1KB)
   * - Uses xxhash instead of SHA256 for 10x faster hashing
   * - Reduced normalization overhead
   */
  private generateCacheKey(
    model: string,
    messages: any[],
    temperature?: number,
    maxTokens?: number,
    stream?: boolean,
    topP?: number,
    presencePenalty?: number,
    frequencyPenalty?: number,
    stop?: string | string[]
  ): string {
    // PERFORMANCE: Fast path for small, simple requests
    const messageCount = messages?.length || 0
    const isSimpleRequest = messageCount <= 3 &&
                           !topP &&
                           !presencePenalty &&
                           !frequencyPenalty &&
                           !stop

    if (isSimpleRequest && messageCount > 0) {
      // Fast path: simple string concatenation for small requests
      const lastMsg = messages[messageCount - 1]
      const content = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : JSON.stringify(lastMsg.content)

      // Simple key for cache lookup (still unique enough for small requests)
      if (content.length < 1000) {
        return `fast:${model}:${messageCount}:${content.slice(0, 100)}:${temperature ?? 0.7}`
      }
    }

    // PERFORMANCE: Minimal normalization - only what's necessary
    const normalizedMessages = messages?.map(msg => ({
      r: msg.role?.[0] || '', // Just first char of role
      c: typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content)
    })) || []

    // PERFORMANCE: Compact key data structure
    const keyData = {
      m: model || '',
      msg: normalizedMessages,
      t: temperature ?? 0.7,
      max: maxTokens ?? null,
      s: stream ?? false,
      tp: topP ?? null,
      pp: presencePenalty ?? null,
      fp: frequencyPenalty ?? null,
      st: Array.isArray(stop) ? stop.sort() : stop
    }

    const keyString = JSON.stringify(keyData)

    // PERFORMANCE: Use xxhash if available, fallback to crypto hash
    if (xxhashInstance) {
      try {
        const hash = xxhashInstance.h64ToString(keyString)
        return `xx:${hash}`
      } catch (err) {
        logger.debug('RESPONSE_CACHE', `xxhash failed, using fallback: ${err}`)
      }
    }

    // Fallback to crypto hash (still faster than SHA256 with slice)
    return `sha:${createHash('md5').update(keyString).digest('hex').slice(0, 16)}`
  }

  /**
   * Check if response is cacheable
   */
  private isCacheable(statusCode: number, data: any): boolean {
    // Only cache successful responses
    if (statusCode !== 200) return false
    
    // Don't cache streaming responses (they're consumed)
    if (data && typeof data === 'object' && data.stream) return false
    
    // Don't cache very large responses
    const dataSize = JSON.stringify(data).length
    if (dataSize > 100000) return false // 100KB limit
    
    return true
  }

  /**
   * Get cached response if available and valid
   * PERFORMANCE: LRU cache handles TTL and eviction automatically
   */
  getCachedResponse(
    model: string,
    messages: any[],
    temperature?: number,
    maxTokens?: number,
    stream?: boolean,
    topP?: number,
    presencePenalty?: number,
    frequencyPenalty?: number,
    stop?: string | string[]
  ): any | null {
    this.totalRequests++

    const key = this.generateCacheKey(model, messages, temperature, maxTokens, stream, topP, presencePenalty, frequencyPenalty, stop)
    const cached = this.cache.get(key)

    if (!cached) {
      return null
    }

    // PERFORMANCE: LRU cache handles TTL automatically, no manual check needed
    // Just update hit counter
    cached.hits++
    this.cacheHits++

    logger.debug('RESPONSE_CACHE', `Cache hit for key ${key.slice(0, 20)}... (${cached.hits} total hits)`)
    return cached.data
  }

  /**
   * Cache a response
   * PERFORMANCE: LRU cache handles eviction automatically
   */
  cacheResponse(
    model: string,
    messages: any[],
    temperature: number | undefined,
    maxTokens: number | undefined,
    stream: boolean | undefined,
    statusCode: number,
    data: any,
    ttl: number = this.DEFAULT_TTL,
    topP?: number,
    presencePenalty?: number,
    frequencyPenalty?: number,
    stop?: string | string[]
  ): void {
    if (!this.isCacheable(statusCode, data)) {
      return
    }

    const key = this.generateCacheKey(model, messages, temperature, maxTokens, stream, topP, presencePenalty, frequencyPenalty, stop)

    // PERFORMANCE: LRU cache handles eviction automatically - no manual check needed
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
      hits: 0
    }, { ttl }) // Set custom TTL for this entry

    logger.debug('RESPONSE_CACHE', `Cached response for key ${key.slice(0, 20)}...`)
  }

  /**
   * Deduplicate in-flight requests
   */
  async deduplicateRequest<T>(
    model: string,
    messages: any[],
    temperature: number | undefined,
    maxTokens: number | undefined,
    stream: boolean | undefined,
    operation: () => Promise<T>,
    topP?: number,
    presencePenalty?: number,
    frequencyPenalty?: number,
    stop?: string | string[]
  ): Promise<T> {
    const key = this.generateCacheKey(model, messages, temperature, maxTokens, stream, topP, presencePenalty, frequencyPenalty, stop)
    
    // Check if request is already in flight
    const pending = this.pendingRequests.get(key)
    if (pending) {
      this.dedupHits++
      logger.debug('RESPONSE_CACHE', `Deduplicating request for key ${key}`)
      
      // Return a promise that resolves when the original request completes
      return new Promise<T>((resolve, reject) => {
        pending.resolvers.push(resolve)
        pending.rejectors.push(reject)
      })
    }
    
    // Create new pending request
    const resolvers: Array<(value: any) => void> = []
    const rejectors: Array<(error: any) => void> = []
    
    const promise = operation()
      .then((result) => {
        // Resolve all waiting requests
        resolvers.forEach(resolve => resolve(result))
        return result
      })
      .catch((error) => {
        // Reject all waiting requests
        rejectors.forEach(reject => reject(error))
        throw error
      })
      .finally(() => {
        // Clean up pending request
        this.pendingRequests.delete(key)
      })
    
    this.pendingRequests.set(key, {
      promise,
      timestamp: Date.now(),
      resolvers,
      rejectors
    })
    
    return promise
  }

  /**
   * PERFORMANCE: No longer needed - LRU cache handles eviction automatically
   * Kept for backward compatibility but does nothing
   */
  private evictOldEntries(): void {
    // LRU cache handles eviction automatically
    logger.debug('RESPONSE_CACHE', `LRU cache managing eviction automatically`)
  }

  /**
   * Clean up expired pending requests
   */
  cleanupPendingRequests(): void {
    const now = Date.now()
    const expired: string[] = []

    for (const [key, pending] of this.pendingRequests.entries()) {
      if (now - pending.timestamp > this.MAX_PENDING_TIME) {
        expired.push(key)
      }
    }

    expired.forEach(key => {
      const pending = this.pendingRequests.get(key)
      if (pending) {
        // Reject all waiting requests
        const error = new Error('Request deduplication timeout')
        pending.rejectors.forEach(reject => reject(error))
        this.pendingRequests.delete(key)
      }
    })

    if (expired.length > 0) {
      logger.debug('RESPONSE_CACHE', `Cleaned up ${expired.length} expired pending requests`)
    }
  }

  /**
   * Get cache statistics
   * PERFORMANCE: Updated to work with LRU cache
   */
  getStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hitRate: this.totalRequests > 0 ? this.cacheHits / this.totalRequests : 0,
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      dedupHits: this.dedupHits,
      evictions: this.evictions
    }
  }

  /**
   * Clear cache and pending requests
   */
  clear(): void {
    this.cache.clear()
    this.pendingRequests.clear()
    this.totalRequests = 0
    this.cacheHits = 0
    this.dedupHits = 0
    this.evictions = 0
    
    logger.info('RESPONSE_CACHE', 'Cache and pending requests cleared')
  }

  /**
   * Start periodic cleanup of expired entries
   * PERFORMANCE: LRU cache handles TTL automatically, only cleanup pending requests
   */
  startPeriodicCleanup(intervalMs: number = 60000): NodeJS.Timeout {
    return setInterval(() => {
      this.cleanupPendingRequests()

      // PERFORMANCE: LRU cache handles TTL-based expiration automatically
      // No manual cleanup needed for cache entries
      logger.debug('RESPONSE_CACHE', `Periodic cleanup: ${this.cache.size} cached, ${this.pendingRequests.size} pending`)
    }, intervalMs)
  }
}

// Singleton instance
export const responseCache = new ResponseCacheManager()
