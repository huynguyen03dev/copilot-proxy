import { logger } from './logger.js'
import { anthropicTransformService } from '../services/anthropicTransformService.js'

/**
 * Wrapper for Hono SSE streams that transforms OpenAI format to Anthropic format
 * 
 * This class wraps a Hono SSE stream and intercepts writeSSE calls to transform
 * OpenAI streaming chunks into Anthropic streaming events, while proxying all
 * other stream methods to the underlying stream.
 */
export class AnthropicStreamWrapper {
  private originalStream: any
  private messageId: string
  private model: string
  private isFirstChunk: boolean = true
  private hasFinished: boolean = false
  private writeCallCount: number = 0

  constructor(originalStream: any, messageId: string, model: string) {
    this.originalStream = originalStream
    this.messageId = messageId
    this.model = model
    
    logger.info('ANTHROPIC_WRAPPER', `🔧 Created wrapper for message ${messageId}, model ${model}`)
    logger.debug('ANTHROPIC_WRAPPER', `Stream object type: ${typeof originalStream}`)
    logger.debug('ANTHROPIC_WRAPPER', `Stream methods: ${Object.keys(originalStream).join(', ')}`)
  }

  /**
   * Intercept writeSSE to transform OpenAI chunks to Anthropic events
   */
  async writeSSE(data: any): Promise<void> {
    this.writeCallCount++
    
    try {
      logger.info('ANTHROPIC_WRAPPER', `📝 writeSSE called (call #${this.writeCallCount})`)
      logger.debug('ANTHROPIC_WRAPPER', `Data type: ${typeof data}`)
      logger.debug('ANTHROPIC_WRAPPER', `Data is array: ${Array.isArray(data)}`)
      logger.debug('ANTHROPIC_WRAPPER', `Data keys: ${typeof data === 'object' && data !== null ? Object.keys(data).join(', ') : 'N/A'}`)
      logger.debug('ANTHROPIC_WRAPPER', `Data preview: ${JSON.stringify(data).substring(0, 200)}`)
      
      // Extract the actual data string from Hono SSE object format
      // Hono's writeSSE can receive either a string or an object like { data: string, event?: string }
      const dataStr = typeof data === 'string' ? data : (data.data || '')
      
      logger.debug('ANTHROPIC_WRAPPER', `Extracted dataStr type: ${typeof dataStr}`)
      logger.debug('ANTHROPIC_WRAPPER', `Extracted dataStr length: ${dataStr.length}`)
      logger.debug('ANTHROPIC_WRAPPER', `Extracted dataStr preview: ${dataStr.substring(0, 200)}`)
      
      if (!dataStr) {
        logger.warn('ANTHROPIC_WRAPPER', `⚠️ No data string extracted, passing through original data`)
        await this.originalStream.writeSSE(data)
        return
      }
      
      // Check if this is the [DONE] signal
      if (dataStr === '[DONE]') {
        logger.info('ANTHROPIC_WRAPPER', `🏁 Received [DONE] signal, sending final events`)
        // Send final Anthropic events
        const events = anthropicTransformService.transformStreamChunkToAnthropicEvent(
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          false,
          true,
          this.messageId,
          this.model
        )
        logger.debug('ANTHROPIC_WRAPPER', `Generated ${events.length} final events`)
        for (const event of events) {
          logger.debug('ANTHROPIC_WRAPPER', `Writing final event: ${event.event}`)
          await this.originalStream.writeSSE({ event: event.event, data: event.data })
        }
        this.hasFinished = true
        return
      }

      // Parse the JSON chunk directly (streaming service sends pre-parsed JSON, not SSE format)
      try {
        const chunk = JSON.parse(dataStr)
        logger.debug('ANTHROPIC_WRAPPER', `Parsed chunk: ${JSON.stringify(chunk).substring(0, 200)}`)
        
        // Transform OpenAI chunk to Anthropic events
        const isLast = chunk.choices?.[0]?.finish_reason !== null && 
                      chunk.choices?.[0]?.finish_reason !== undefined
        
        logger.debug('ANTHROPIC_WRAPPER', `isFirst: ${this.isFirstChunk}, isLast: ${isLast}`)
        
        const events = anthropicTransformService.transformStreamChunkToAnthropicEvent(
          chunk,
          this.isFirstChunk,
          isLast,
          this.messageId,
          this.model
        )

        logger.info('ANTHROPIC_WRAPPER', `✨ Generated ${events.length} Anthropic events from chunk`)
        
        // Write all events
        for (const event of events) {
          logger.debug('ANTHROPIC_WRAPPER', `Writing event: ${event.event}, data length: ${event.data.length}`)
          await this.originalStream.writeSSE({ event: event.event, data: event.data })
          logger.debug('ANTHROPIC_WRAPPER', `✅ Event written successfully`)
        }

        this.isFirstChunk = false

        if (isLast) {
          logger.info('ANTHROPIC_WRAPPER', `🏁 Last chunk processed`)
          this.hasFinished = true
        }
      } catch (parseError) {
        logger.error('ANTHROPIC_WRAPPER', `❌ Failed to parse chunk: ${parseError}`)
        logger.error('ANTHROPIC_WRAPPER', `Problematic JSON: ${dataStr.substring(0, 500)}`)
      }
      
      logger.debug('ANTHROPIC_WRAPPER', `✅ writeSSE completed (call #${this.writeCallCount})`)
    } catch (error) {
      logger.error('ANTHROPIC_WRAPPER', `💥 Error in writeSSE (call #${this.writeCallCount}): ${error}`)
      logger.error('ANTHROPIC_WRAPPER', `Error stack: ${error instanceof Error ? error.stack : 'N/A'}`)
      throw error
    }
  }

  /**
   * Proxy onAbort to the original stream
   */
  onAbort(callback: () => void): void {
    logger.debug('ANTHROPIC_WRAPPER', `📞 onAbort called`)
    if (this.originalStream.onAbort) {
      this.originalStream.onAbort(callback)
    } else {
      logger.warn('ANTHROPIC_WRAPPER', `⚠️ originalStream.onAbort not available`)
    }
  }

  /**
   * Proxy close to the original stream
   */
  async close(): Promise<void> {
    logger.debug('ANTHROPIC_WRAPPER', `📞 close called`)
    if (this.originalStream.close) {
      await this.originalStream.close()
    } else {
      logger.warn('ANTHROPIC_WRAPPER', `⚠️ originalStream.close not available`)
    }
  }

  /**
   * Proxy sleep to the original stream
   */
  async sleep(ms: number): Promise<void> {
    logger.debug('ANTHROPIC_WRAPPER', `📞 sleep called (${ms}ms)`)
    if (this.originalStream.sleep) {
      await this.originalStream.sleep(ms)
    } else {
      logger.warn('ANTHROPIC_WRAPPER', `⚠️ originalStream.sleep not available`)
    }
  }

  /**
   * Proxy abort to the original stream
   */
  abort(): void {
    logger.debug('ANTHROPIC_WRAPPER', `📞 abort called`)
    if (this.originalStream.abort) {
      this.originalStream.abort()
    } else {
      logger.warn('ANTHROPIC_WRAPPER', `⚠️ originalStream.abort not available`)
    }
  }

  /**
   * Proxy any other method calls to the original stream
   */
  [key: string]: any
}

// Use Proxy to automatically forward all methods we haven't explicitly defined
export function createAnthropicStreamWrapper(
  originalStream: any, 
  messageId: string, 
  model: string
): any {
  const wrapper = new AnthropicStreamWrapper(originalStream, messageId, model)
  
  return new Proxy(wrapper, {
    get(target, prop, receiver) {
      // If the wrapper has the property, use it
      if (prop in target) {
        return Reflect.get(target, prop, receiver)
      }
      
      // Otherwise, proxy to the original stream
      const originalValue = (target as any).originalStream[prop]
      
      // If it's a function, bind it to the original stream
      if (typeof originalValue === 'function') {
        return originalValue.bind((target as any).originalStream)
      }
      
      return originalValue
    }
  })
}


