import { logger } from '../utils/logger.js'
import { ChatCompletionRequest, ContentBlock } from '../types.js'
import { endpointCache, EndpointConfig } from '../utils/endpointCache.js'
import { connectionPool } from '../utils/connectionPool.js'
import { transformMessagesForCopilot } from '../utils/content.js'

/**
 * Result of endpoint discovery
 */
export interface EndpointDiscoveryResult {
  /**
   * Discovered or cached endpoint URL
   */
  url: string
  
  /**
   * Request body formatted for the endpoint
   */
  requestBody: any
  
  /**
   * Whether the result came from cache
   */
  fromCache: boolean
  
  /**
   * Response time (if discovered, not cached)
   */
  responseTime?: number
}

/**
 * Service for discovering optimal Copilot API endpoints
 * 
 * Features:
 * - Endpoint caching to avoid repeated discovery
 * - Parallel endpoint discovery with cancellation
 * - Multiple endpoint format support
 * - Intelligent request body building
 */
export class EndpointDiscoveryService {
  /**
   * Discover optimal endpoint using cache or parallel discovery
   */
  async discoverOptimalEndpoint(
    token: string,
    request: ChatCompletionRequest,
    baseEndpoint: string
  ): Promise<EndpointDiscoveryResult> {
    // Check cache first
    const cachedEndpoint = endpointCache.getBestEndpoint(baseEndpoint, request.model)
    
    if (cachedEndpoint) {
      const requestBody = this.buildRequestBody(request, cachedEndpoint.format)
      return {
        url: cachedEndpoint.url,
        requestBody,
        fromCache: true
      }
    }
    
    // Fallback to discovery if no cache hit
    return this.performEndpointDiscovery(token, request, baseEndpoint)
  }
  
  /**
   * Build request body based on endpoint format
   */
  buildRequestBody(request: ChatCompletionRequest, format: number): any {
    const transformedMessages = transformMessagesForCopilot(request.messages as Array<{
      role: "system" | "user" | "assistant"
      content: string | ContentBlock[]
    }>)
    const safeStopParam = this.getSafeStopParam(request.stop)
    
    const baseRequest = {
      model: request.model,
      messages: transformedMessages,
      temperature: request.temperature || 0.7,
      max_tokens: request.max_tokens,
      stream: false,
      top_p: request.top_p,
      ...safeStopParam,
    }
    
    switch (format) {
      case 0:
        return baseRequest
      case 1:
        return { ...baseRequest, intent: true, n: 1 }
      case 2:
        return {
          prompt: transformedMessages.map(m => `${m.role}: ${m.content}`).join('\n'),
          max_tokens: request.max_tokens || 150,
          temperature: request.temperature || 0.7,
          top_p: request.top_p || 1,
          n: 1,
          stream: false,
          ...safeStopParam,
        }
      default:
        return baseRequest
    }
  }
  
  /**
   * Perform parallel endpoint discovery with caching
   * 
   * Uses Promise.allSettled with AbortController to cancel losing attempts.
   * This eliminates the N+1 sequential discovery problem.
   */
  private async performEndpointDiscovery(
    token: string,
    request: ChatCompletionRequest,
    baseEndpoint: string
  ): Promise<EndpointDiscoveryResult> {
    const configs = endpointCache.getEndpointConfigs()
    
    // Create AbortController for each endpoint attempt (parallel discovery optimization)
    const controllers = configs.map(() => new AbortController())
    
    // Build request data for each endpoint configuration
    const endpointAttempts = configs.map((config, index) => {
      const url = `${baseEndpoint}${config.path}`
      const requestBody = { 
        model: request.model, 
        messages: [{ role: 'user', content: 'ping' }], 
        max_tokens: 1, 
        temperature: 0, 
        stream: false 
      }
      
      return {
        config,
        url,
        requestBody,
        controller: controllers[index],
        promise: connectionPool.request(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "GitHubCopilotChat/0.26.7",
            "Editor-Version": "vscode/1.99.3",
            "Editor-Plugin-Version": "copilot-chat/0.26.7",
          },
          body: JSON.stringify(requestBody),
          timeout: 15000,
          signal: controllers[index].signal  // Enable cancellation for parallel optimization
        }).catch(error => ({ error, statusCode: 0 })) // Convert errors to results for Promise.allSettled
      }
    })
    
    try {
      // Execute all endpoint attempts in parallel (major performance improvement)
      const results = await Promise.allSettled(endpointAttempts.map(attempt => attempt.promise))
      
      // Find first successful response and cancel others
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        const attempt = endpointAttempts[i]
        
        if (result.status === 'fulfilled' && !('error' in result.value) && result.value.statusCode === 200) {
          // Success! Cancel all other pending requests to save resources
          controllers.forEach((controller, idx) => {
            if (idx !== i) {
              controller.abort()
            }
          })
          
          // Cache the successful endpoint for future requests
          endpointCache.cacheSuccessfulEndpoint(
            baseEndpoint,
            request.model,
            attempt.config,
            result.value.responseTime
          )
          
          logger.info('ENDPOINT_DISCOVERY',
            `✅ Parallel discovery succeeded: ${attempt.url} (${result.value.responseTime}ms) - cancelled ${configs.length - 1} other attempts`
          )
          
          // IMPORTANT: return requestBody for the ACTUAL user request (not the discovery 'ping')
          const actualRequestBody = this.buildRequestBody(request, attempt.config.format)
          return { 
            url: attempt.url, 
            requestBody: actualRequestBody,
            fromCache: false,
            responseTime: result.value.responseTime
          }
        }
      }
      
      // No successful responses - record failures for cache management
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        const attempt = endpointAttempts[i]
        
        if (result.status === 'fulfilled' && !('error' in result.value) && result.value.statusCode !== 404) {
          endpointCache.recordEndpointFailure(baseEndpoint, request.model, attempt.config)
        } else if (result.status === 'rejected' || ('error' in result.value)) {
          endpointCache.recordEndpointFailure(baseEndpoint, request.model, attempt.config)
        }
      }
      
    } finally {
      // Ensure all controllers are aborted to clean up resources
      controllers.forEach(controller => controller.abort())
    }
    
    throw new Error(`All Copilot API endpoints failed for parallel discovery`)
  }
  
  /**
   * Helper method for safe stop parameter handling
   */
  private getSafeStopParam(stop?: string | string[]) {
    if (stop === null || stop === undefined) {
      return {}
    }
    if (typeof stop === 'string' && stop.length > 0) {
      return { stop }
    }
    if (Array.isArray(stop) && stop.length > 0) {
      return { stop }
    }
    return {}
  }
}

/**
 * Singleton instance for convenience
 */
export const endpointDiscoveryService = new EndpointDiscoveryService()
