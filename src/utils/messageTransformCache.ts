/**
 * Message Transformation Cache
 * PERFORMANCE OPTIMIZATION (Phase 2, Issue #5):
 * Request-scoped memoization for transformMessagesForCopilot()
 * Prevents redundant transformations when endpoint is cached
 */

import { logger } from './logger.js'
import { LRUCache } from 'lru-cache'
import xxhash from 'xxhash-wasm'

// PERFORMANCE: Initialize xxhash once for reuse
let xxhashInstance: any = null
const initXXHash = async () => {
  if (!xxhashInstance) {
    const hasher = await xxhash()
    xxhashInstance = hasher
  }
  return xxhashInstance
}

interface TransformCacheEntry {
  transformedMessages: any[]
  timestamp: number
}

/**
 * Message transformation cache manager
 * Provides request-scoped memoization keyed by model:messages.length:format
 */
export class MessageTransformCache {
  private cache: LRUCache<string, TransformCacheEntry>
  private readonly MAX_CACHE_SIZE = 500
  private readonly CACHE_TTL = 60000 // 1 minute (short TTL for request-scoped cache)
  
  // Statistics
  private hitCount = 0
  private missCount = 0
  
  constructor() {
    this.cache = new LRUCache<string, TransformCacheEntry>({
      max: this.MAX_CACHE_SIZE,
      ttl: this.CACHE_TTL,
      updateAgeOnGet: true,
      dispose: (value, key) => {
        logger.debug('TRANSFORM_CACHE', `Evicted transform cache entry: ${key.slice(0, 20)}...`)
      }
    })
    
    // Initialize xxhash asynchronously
    initXXHash().catch(err => {
      logger.warn('TRANSFORM_CACHE', `Failed to initialize xxhash: ${err}`)
    })
  }
  
  /**
   * Generate cache key from model and messages
   * PERFORMANCE: Fast fingerprinting based on model, message count, and content hash
   */
  private generateKey(model: string, messages: any[]): string {
    // Fast path for small message arrays
    if (messages.length <= 3) {
      const summary = messages.map(m => 
        `${m.role}:${typeof m.content === 'string' ? m.content.length : 'arr'}`
      ).join('|')
      return `${model}:${messages.length}:${summary}`
    }
    
    // For larger arrays, create a fingerprint
    let totalLength = 0
    const roles: string[] = []
    
    for (const msg of messages) {
      roles.push(msg.role)
      if (typeof msg.content === 'string') {
        totalLength += msg.content.length
      } else if (Array.isArray(msg.content)) {
        totalLength += JSON.stringify(msg.content).length
      }
    }
    
    const fingerprint = `${model}:${messages.length}:${roles.join(',')}:${totalLength}`
    
    // Use xxhash for large fingerprints
    if (xxhashInstance && fingerprint.length > 200) {
      try {
        const hash = xxhashInstance.h64ToString(fingerprint)
        return `xx:${hash}`
      } catch (err) {
        // Fallback
      }
    }
    
    return fingerprint
  }
  
  /**
   * Get cached transformed messages
   */
  get(model: string, messages: any[]): any[] | null {
    const key = this.generateKey(model, messages)
    const cached = this.cache.get(key)
    
    if (cached) {
      this.hitCount++
      logger.debug('TRANSFORM_CACHE', 
        `✅ Transform cache hit (${this.getHitRate().toFixed(1)}% hit rate)`
      )
      return cached.transformedMessages
    }
    
    this.missCount++
    return null
  }
  
  /**
   * Cache transformed messages
   */
  set(model: string, messages: any[], transformedMessages: any[]): void {
    const key = this.generateKey(model, messages)
    
    this.cache.set(key, {
      transformedMessages,
      timestamp: Date.now()
    })
    
    logger.debug('TRANSFORM_CACHE', 
      `📦 Cached message transformation (size: ${this.cache.size}/${this.cache.max})`
    )
  }
  
  /**
   * Get hit rate percentage
   */
  getHitRate(): number {
    const total = this.hitCount + this.missCount
    return total > 0 ? (this.hitCount / total) * 100 : 0
  }
  
  /**
   * Get cache statistics
   */
  getStats(): {
    size: number
    maxSize: number
    hitRate: number
    hitCount: number
    missCount: number
  } {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hitRate: this.getHitRate(),
      hitCount: this.hitCount,
      missCount: this.missCount
    }
  }
  
  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear()
    this.hitCount = 0
    this.missCount = 0
    logger.info('TRANSFORM_CACHE', 'Message transformation cache cleared')
  }
}

// Singleton instance
export const messageTransformCache = new MessageTransformCache()

