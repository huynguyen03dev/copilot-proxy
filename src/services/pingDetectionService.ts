import { logger } from '../utils/logger.js'
import { ChatCompletionRequest } from '../types.js'

/**
 * Configuration for ping detection service
 */
export interface PingDetectionConfig {
  /**
   * Ping handling mode:
   * - 'off': No special handling (default)
   * - 'suppress': Suppress streaming for ping requests
   * - 'enhance': Enhance ping responses with minimum tokens
   */
  mode: 'off' | 'suppress' | 'enhance'
  
  /**
   * Minimum tokens for streaming ping responses (default: 4)
   */
  minStreamTokens: number
}

/**
 * Result of ping detection
 */
export interface PingDetectionResult {
  /**
   * Whether the request is likely a ping
   */
  isPing: boolean
  
  /**
   * Original request body
   */
  originalRequest: ChatCompletionRequest
  
  /**
   * Modified request body (if applicable)
   */
  modifiedRequest: ChatCompletionRequest
  
  /**
   * Detected ping text (if any)
   */
  pingText?: string
}

/**
 * Service for detecting and handling ping-style requests
 * 
 * Ping detection uses heuristics to identify simple connectivity test requests:
 * - Must be a streaming request
 * - Must have temperature = 0
 * - Must have exactly one user message
 * - Message must be short (≤6 chars) and simple (≤2 words)
 * - Message must match common ping patterns (ping, hello, hi, hey, test, ok)
 */
export class PingDetectionService {
  private config: PingDetectionConfig
  
  /**
   * Common ping keywords
   */
  private readonly PING_KEYWORDS = new Set(['ping', 'hello', 'hi', 'hey', 'test', 'ok'])
  
  /**
   * Maximum length for ping text (characters)
   */
  private readonly MAX_PING_LENGTH = 6
  
  /**
   * Maximum words in ping text
   */
  private readonly MAX_PING_WORDS = 2
  
  constructor(config?: Partial<PingDetectionConfig>) {
    this.config = {
      mode: (process.env.PING_HANDLING?.toLowerCase() as 'off' | 'suppress' | 'enhance') || 'off',
      minStreamTokens: Number(process.env.PING_MIN_TOKENS ?? process.env.STREAM_MIN_TOKENS ?? 4),
      ...config
    }
  }
  
  /**
   * Detect if a request is likely a ping
   */
  detectPing(request: ChatCompletionRequest): boolean {
    try {
      // STRICT: only consider streaming, temp=0, and single short user message
      if (request.stream !== true) return false
      if ((request.temperature ?? null) !== 0) return false
      if (!Array.isArray(request.messages) || request.messages.length !== 1) return false
      
      const message = request.messages[0]
      if (!message || (message as any).role !== 'user') return false
      
      const text = this.normalize(this.extractPlainText(message))
      if (!text) return false
      
      // Heuristics: very short and simple
      const words = text.split(/\s+/)
      const shortEnough = text.length <= this.MAX_PING_LENGTH && words.length <= this.MAX_PING_WORDS
      
      if (shortEnough && this.PING_KEYWORDS.has(text)) return true
      
      return false
    } catch {
      return false
    }
  }
  
  /**
   * Apply ping handling to a request based on configuration
   */
  handlePing(request: ChatCompletionRequest): PingDetectionResult {
    const isPing = this.detectPing(request)
    const effectiveBody = { ...request }
    let pingText: string | undefined
    
    if (isPing && request.messages.length > 0) {
      pingText = this.normalize(this.extractPlainText(request.messages[0]))
    }
    
    // Log ping detection if handling is off
    if (this.config.mode === 'off' && isPing) {
      try {
        logger.info('PING', 
          `Detected ping-style request (handling=off). text="${pingText}" len=${pingText?.length ?? 0} ` +
          `max_tokens=${String(effectiveBody.max_tokens)} stream=${String(effectiveBody.stream)} ` +
          `temp=${String(effectiveBody.temperature)}`
        )
      } catch { }
    }
    
    // Apply handling if not off and conditions match
    if (
      this.config.mode !== 'off' && 
      isPing &&
      effectiveBody.stream === true &&
      typeof effectiveBody.max_tokens === 'number' &&
      effectiveBody.max_tokens <= 1
    ) {
      try {
        logger.info('PING',
          `Detected ping-style request. mode=${this.config.mode} text="${pingText}" len=${pingText?.length ?? 0} ` +
          `original_max_tokens=${String(request.max_tokens ?? 'unset')} stream=${String(effectiveBody.stream)} ` +
          `temp=${String(effectiveBody.temperature)}`
        )
      } catch { }
      
      if (this.config.mode === 'enhance') {
        const before = effectiveBody.max_tokens
        effectiveBody.max_tokens = Math.max(this.config.minStreamTokens, 2)
        logger.info('PING', `Enhancing ping response: bump max_tokens ${before} -> ${effectiveBody.max_tokens}`)
      }
      
      // Note: 'suppress' mode would be handled by caller (convert to non-streaming)
    }
    
    return {
      isPing,
      originalRequest: request,
      modifiedRequest: effectiveBody,
      pingText
    }
  }
  
  /**
   * Extract plain text from a message content
   */
  private extractPlainText(message: any): string {
    const content = message?.content
    
    if (this.isString(content)) {
      return content
    }
    
    if (Array.isArray(content)) {
      const textBlock = content.find((block: any) => this.isString(block?.text))
      if (textBlock && this.isString(textBlock.text)) {
        return textBlock.text
      }
    }
    
    return ''
  }
  
  /**
   * Normalize text for comparison
   */
  private normalize(text: string): string {
    return text.trim().toLowerCase()
  }
  
  /**
   * Type guard for string
   */
  private isString(value: unknown): value is string {
    return typeof value === 'string'
  }
  
  /**
   * Get current configuration
   */
  getConfig(): PingDetectionConfig {
    return { ...this.config }
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<PingDetectionConfig>): void {
    this.config = {
      ...this.config,
      ...config
    }
  }
}

/**
 * Singleton instance for convenience
 */
export const pingDetectionService = new PingDetectionService()
