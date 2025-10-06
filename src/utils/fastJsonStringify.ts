/**
 * Fast JSON Stringify
 * PERFORMANCE OPTIMIZATION (Phase 3, Issue #12):
 * Uses fast-json-stringify with precompiled schemas for 2-3x faster serialization
 * in streaming hot paths
 */

import fastJsonStringify from 'fast-json-stringify'
import { logger } from './logger.js'

/**
 * Schema for streaming chunk responses
 * Based on OpenAI's streaming response format
 */
const streamChunkSchema = {
  title: 'Stream Chunk',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    created: { type: 'number' },
    model: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          delta: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' }
            }
          },
          finish_reason: { 
            type: ['string', 'null'],
            nullable: true 
          }
        }
      }
    },
    usage: {
      type: 'object',
      nullable: true,
      properties: {
        prompt_tokens: { type: 'number' },
        completion_tokens: { type: 'number' },
        total_tokens: { type: 'number' }
      }
    }
  }
}

/**
 * Schema for non-streaming completion responses
 */
const completionSchema = {
  title: 'Completion',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    created: { type: 'number' },
    model: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          message: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              content: { type: 'string' }
            }
          },
          finish_reason: { type: 'string' }
        }
      }
    },
    usage: {
      type: 'object',
      properties: {
        prompt_tokens: { type: 'number' },
        completion_tokens: { type: 'number' },
        total_tokens: { type: 'number' }
      }
    }
  }
}

// PERFORMANCE: Precompile schemas for fast serialization
let streamChunkStringify: ReturnType<typeof fastJsonStringify> | null = null
let completionStringify: ReturnType<typeof fastJsonStringify> | null = null
let initializationError: Error | null = null

/**
 * Initialize fast JSON stringifiers
 */
function initializeFastStringify(): void {
  try {
    streamChunkStringify = fastJsonStringify(streamChunkSchema)
    completionStringify = fastJsonStringify(completionSchema)
    logger.info('FAST_JSON', 'Fast JSON stringify initialized successfully')
  } catch (error) {
    initializationError = error as Error
    logger.warn('FAST_JSON', `Failed to initialize fast JSON stringify: ${error}`)
  }
}

// Initialize on module load
initializeFastStringify()

/**
 * Fast stringify for streaming chunks
 * PERFORMANCE: 2-3x faster than JSON.stringify for known schemas
 */
export function stringifyStreamChunk(chunk: any): string {
  if (!streamChunkStringify) {
    // Fallback to standard JSON.stringify
    if (initializationError) {
      logger.debug('FAST_JSON', 'Using fallback JSON.stringify due to initialization error')
    }
    return JSON.stringify(chunk)
  }
  
  try {
    return streamChunkStringify(chunk)
  } catch (error) {
    // Fallback on error
    logger.warn('FAST_JSON', `Fast stringify failed, using fallback: ${error}`)
    return JSON.stringify(chunk)
  }
}

/**
 * Fast stringify for completion responses
 * PERFORMANCE: 2-3x faster than JSON.stringify for known schemas
 */
export function stringifyCompletion(completion: any): string {
  if (!completionStringify) {
    // Fallback to standard JSON.stringify
    return JSON.stringify(completion)
  }
  
  try {
    return completionStringify(completion)
  } catch (error) {
    // Fallback on error
    logger.warn('FAST_JSON', `Fast stringify failed, using fallback: ${error}`)
    return JSON.stringify(completion)
  }
}

/**
 * Generic fast stringify with fallback
 * Uses fast-json-stringify if schema matches, otherwise falls back to JSON.stringify
 */
export function fastStringify(obj: any, isStreamChunk: boolean = false): string {
  if (isStreamChunk) {
    return stringifyStreamChunk(obj)
  }
  
  // Try to detect if it's a completion response
  if (obj && obj.choices && obj.model) {
    return stringifyCompletion(obj)
  }
  
  // Fallback to standard JSON.stringify for unknown schemas
  return JSON.stringify(obj)
}

/**
 * Get initialization status
 */
export function getFastStringifyStatus(): {
  initialized: boolean
  error: string | null
} {
  return {
    initialized: streamChunkStringify !== null && completionStringify !== null,
    error: initializationError ? initializationError.message : null
  }
}

