import { logger } from '../../utils/logger.js'
import { ChatCompletionRequest, ChatCompletionResponse } from '../../types.js'
import { EndpointDiscoveryService } from '../endpointDiscoveryService.js'
import { ResponseTransformService } from '../responseTransformService.js'
import { StreamMonitorService } from '../streamMonitorService.js'
import { connectionPool } from '../../utils/connectionPool.js'
import { responseCache } from '../../utils/responseCache.js'
import { NetworkErrorBoundary } from '../../utils/errorBoundary.js'

/**
 * Configuration for warmup cache
 */
interface WarmupCache {
  lastWarmup: Map<string, number>
  ttl: number
}

/**
 * Main service for handling chat completion requests
 * 
 * Coordinates:
 * - Endpoint discovery
 * - Request forwarding
 * - Response transformation
 * - Stream monitoring
 * - Connection warmup
 * - Response caching
 */
export class ChatService {
  private endpointDiscovery: EndpointDiscoveryService
  private responseTransform: ResponseTransformService
  private streamMonitor: StreamMonitorService
  private warmupCache: WarmupCache
  
  constructor(
    endpointDiscovery: EndpointDiscoveryService,
    responseTransform: ResponseTransformService,
    streamMonitor: StreamMonitorService
  ) {
    this.endpointDiscovery = endpointDiscovery
    this.responseTransform = responseTransform
    this.streamMonitor = streamMonitor
    this.warmupCache = {
      lastWarmup: new Map<string, number>(),
      ttl: 300000 // 5 minutes TTL for warmup cache
    }
  }
  
  /**
   * Forward non-streaming request to Copilot API
   */
  async forwardToCopilot(
    token: string,
    request: ChatCompletionRequest,
    endpoint: string
  ): Promise<ChatCompletionResponse> {
    logger.debug('COPILOT_REQUEST', `Transformed ${request.messages.length} message(s) for Copilot compatibility`)
    
    // Check response cache first
    const cachedResponse = responseCache.getCachedResponse(
      request.model,
      request.messages,
      request.temperature,
      request.max_tokens,
      false, // non-streaming
      request.top_p,
      request.presence_penalty,
      request.frequency_penalty,
      request.stop
    )
    
    if (cachedResponse) {
      logger.info('RESPONSE_CACHE', `✅ Cache hit for non-streaming request`)
      return cachedResponse
    }
    
    try {
      // Deduplicate identical in-flight requests
      return await responseCache.deduplicateRequest(
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        false, // non-streaming
        async () => {
          // Use optimized endpoint discovery
          const { url, requestBody } = await this.endpointDiscovery.discoverOptimalEndpoint(token, request, endpoint)
          
          // Smart warmup with TTL to prevent repeated warmups
          const urlObj = new URL(url)
          const origin = `${urlObj.protocol}//${urlObj.host}`
          void this.smartWarmupConnections(origin, 2).catch(() => {
            // Warmup is best-effort, don't fail the main request
          })
          
          logger.debug('COPILOT_REQUEST', `Using endpoint: ${url}`)
          logger.debug('COPILOT_REQUEST', `Request body: ${JSON.stringify(requestBody, null, 2)}`)
          
          // Wrap network request in error boundary
          const networkResult = await NetworkErrorBoundary.handleRequest(
            async () => {
              const response = await connectionPool.request(url, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${token}`,
                  "Content-Type": "application/json",
                  "User-Agent": "GitHubCopilotChat/0.26.7",
                  "Editor-Version": "vscode/1.99.3",
                  "Editor-Plugin-Version": "copilot-chat/0.26.7",
                },
                body: JSON.stringify(requestBody),
                timeout: 15000
              })
              
              if (response.statusCode === 200) {
                const copilotResponse = JSON.parse(response.body)
                const actualModel = copilotResponse.model || request.model || 'unknown'
                logger.info('ENDPOINT', `✅ Non-streaming success: ${url} (${response.responseTime}ms)`)
                logger.info('MODEL', `🤖 Non-streaming response using model: ${actualModel}`)
                logger.debug('RESPONSE', `Copilot response received: ${JSON.stringify(copilotResponse, null, 2)}`)
                
                const transformedResponse = this.responseTransform.transformResponse(copilotResponse, request)
                
                // Cache successful response
                responseCache.cacheResponse(
                  request.model,
                  request.messages,
                  request.temperature,
                  request.max_tokens,
                  false, // non-streaming
                  response.statusCode,
                  transformedResponse,
                  60000, // 60 second TTL
                  request.top_p,
                  request.presence_penalty,
                  request.frequency_penalty,
                  request.stop
                )
                
                return transformedResponse
              } else {
                throw new Error(`HTTP ${response.statusCode}: ${response.body}`)
              }
            },
            url,
            {
              retryAttempts: 1,
              retryDelay: 500,
              timeoutMs: 15000,
              category: 'NETWORK'
            }
          )
          
          if (networkResult.success && networkResult.data) {
            return networkResult.data
          } else {
            throw new Error(networkResult.error?.message || "Network request failed")
          }
        },
        request.top_p,
        request.presence_penalty,
        request.frequency_penalty,
        request.stop
      )
    } catch (error) {
      if (error instanceof Error && (error.message === 'QUEUE_SATURATED' || error.message === 'QUEUE_TIMEOUT')) {
        // Preserve queue errors for caller to map to 503/504
        throw error
      }
      logger.error('ENDPOINT', `❌ All endpoint attempts failed: ${error}`)
      throw new Error(`All Copilot API endpoints failed. Error: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }
  
  /**
   * Forward streaming request to Copilot API
   */
  async forwardToCopilotStreaming(
    token: string,
    request: ChatCompletionRequest,
    endpoint: string,
    stream: any,
    streamId: string
  ): Promise<void> {
    logger.debug('STREAM', `🔄 Starting streaming request ${streamId}`)
    
    try {
      // Use unified endpoint discovery with caching
      const { url, requestBody } = await this.endpointDiscovery.discoverOptimalEndpoint(token, request, endpoint)
      
      // Ensure streaming is enabled in the request body
      const streamingRequestBody = {
        ...requestBody,
        stream: true
      }
      
      logger.debug('STREAM', `🔄 Using cached/discovered endpoint: ${url}`)
      logger.debug('STREAM', `🔄 Streaming request body: ${JSON.stringify(streamingRequestBody, null, 2)}`)
      
      // Use pooled connection for streaming
      const response = await connectionPool.streamRequest(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "Editor-Version": "vscode/1.99.3",
          "Editor-Plugin-Version": "copilot-chat/0.26.7",
        },
        body: JSON.stringify(streamingRequestBody),
        timeout: 60000 // align with 30s chunk timeout; avoid premature aborts
      })
      
      if (response.statusCode === 200) {
        // Smart warmup with TTL to prevent repeated warmups
        const urlObj = new URL(url)
        const origin = `${urlObj.protocol}//${urlObj.host}`
        void this.smartWarmupConnections(origin, 2).catch(() => {
          // Warmup is best-effort, don't fail the main request
        })
        
        logger.info('STREAM', `✅ Streaming success: ${url} (${response.responseTime}ms)`)
        
        // Import streamingService to process the stream
        const { streamingService } = await import('../streamingService.js')
        
        // Create a Response object for streamingService.processStream()
        const fetchResponse = new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as HeadersInit
        })
        
        // Process the stream using streamingService
        await streamingService.processStream(fetchResponse, stream, request, streamId, {
          useOptimizations: true,
          apiUrl: url,
          maxBufferSize: 16 * 1024 * 1024 // 16MB default
        })
        
        logger.info('STREAM', `🎉 Streaming request ${streamId} completed successfully`)
        return
      } else {
        throw new Error(`HTTP ${response.statusCode}: Streaming request failed`)
      }
    } catch (error) {
      const streamError = error instanceof Error ? error : new Error("Unknown streaming error")
      logger.error('STREAM', `💥 Streaming error in streaming-${streamId}: ${streamError.message}`)
      throw streamError
    }
  }
  
  /**
   * Smart warmup with TTL to prevent repeated warmups
   * Only warms up connections once per origin within the TTL period
   */
  private async smartWarmupConnections(origin: string, count: number = 2): Promise<void> {
    const now = Date.now()
    const lastWarmup = this.warmupCache.lastWarmup.get(origin)
    
    // Skip if warmed up recently (within TTL)
    if (lastWarmup && (now - lastWarmup) < this.warmupCache.ttl) {
      logger.debug('WARMUP', `Skipping warmup for ${origin} - warmed up ${Math.round((now - lastWarmup) / 1000)}s ago`)
      return
    }
    
    // Clean up expired entries while we're here
    for (const [cachedOrigin, timestamp] of this.warmupCache.lastWarmup.entries()) {
      if ((now - timestamp) > this.warmupCache.ttl) {
        this.warmupCache.lastWarmup.delete(cachedOrigin)
      }
    }
    
    // Perform warmup and cache the timestamp
    try {
      await connectionPool.warmupConnections(origin, count)
      this.warmupCache.lastWarmup.set(origin, now)
      logger.debug('WARMUP', `✅ Warmed up ${count} connections to ${origin}`)
    } catch (error) {
      logger.debug('WARMUP', `⚠️ Warmup failed for ${origin}: ${error}`)
      // Don't cache failed warmups
    }
  }
}

/**
 * Factory function to create ChatService with dependencies
 */
export function createChatService(
  endpointDiscovery: EndpointDiscoveryService,
  responseTransform: ResponseTransformService,
  streamMonitor: StreamMonitorService
): ChatService {
  return new ChatService(endpointDiscovery, responseTransform, streamMonitor)
}
