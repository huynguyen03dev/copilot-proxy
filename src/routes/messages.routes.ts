import { Hono, Context } from "hono"
import { streamSSE } from "hono/streaming"
import { GitHubCopilotAuth } from "../auth.js"
import { AnthropicMessagesRequest } from "../types/anthropic.js"
import { createAPIErrorResponse } from "../types/errors.js"
import { logger } from "../utils/logger.js"
import { config } from "../config/index.js"
import { ChatService } from "../services/chat/chatService.js"
import { StreamMonitorService } from "../services/streamMonitorService.js"
import { anthropicTransformService } from "../services/anthropicTransformService.js"
import { createAnthropicStreamWrapper } from "../utils/anthropicStreamWrapper.js"

/**
 * Anthropic Messages API route handlers
 * Provides Claude-compatible /v1/messages endpoint
 * Translates requests to OpenAI format for GitHub Copilot compatibility
 */

export interface MessagesRouteDependencies {
  chatService: ChatService
  streamMonitor: StreamMonitorService
  maxConcurrentStreams: number
  isTestEnvironment: boolean
}

/**
 * Create messages routes (Anthropic API compatibility)
 * @param deps - Dependencies required by messages routes
 */
export function createMessagesRoutes(deps: MessagesRouteDependencies): Hono {
  const app = new Hono()

  /**
   * Handle unsupported HTTP methods for messages endpoint
   */
  app.all("/messages", async (c, next): Promise<Response | void> => {
    if (c.req.method !== "POST") {
      const errorResponse = createAPIErrorResponse(
        `Method ${c.req.method} not allowed. Only POST is supported.`,
        "method_not_allowed_error",
        "METHOD_NOT_ALLOWED"
      )
      c.header("Allow", "POST")
      return c.json(errorResponse, 405)
    }
    await next()
  })

  /**
   * POST /v1/messages - Anthropic Claude-compatible messages endpoint
   * Supports both streaming and non-streaming requests
   * Translates Anthropic format to OpenAI format for GitHub Copilot
   */
  app.post("/messages", async (c: any) => {
    try {
      // Parse and validate request body
      const rawBody = await c.req.json()
      const validationResult = AnthropicMessagesRequest.safeParse(rawBody)

      if (!validationResult.success) {
        const errorMessage = validationResult.error.issues.map(issue => {
          const pathStr = issue.path.join('.')
          return `${pathStr}: ${issue.message}`
        }).join(', ')

        const errorResponse = createAPIErrorResponse(
          errorMessage,
          "invalid_request_error",
          "VALIDATION_ERROR"
        )
        return c.json(errorResponse, 400)
      }

      const anthropicRequest = validationResult.data

      // Log request details in development
      if (config.environment === 'development') {
        logger.debug('ANTHROPIC_REQUEST', `Model: ${anthropicRequest.model}, Messages: ${anthropicRequest.messages.length}, Stream: ${anthropicRequest.stream || false}`)
      }

      // Check authentication
      const token = await GitHubCopilotAuth.getAccessToken()
      if (!token) {
        const errorResponse = createAPIErrorResponse(
          "Not authenticated with GitHub Copilot. Please authenticate first.",
          "authentication_error",
          "invalid_api_key"
        )
        return c.json(errorResponse, 401)
      }

      // Transform Anthropic request to OpenAI format
      const openAIRequest = anthropicTransformService.transformAnthropicToOpenAI(anthropicRequest)

      try {
        // Get the dynamic Copilot endpoint
        const endpoint = await GitHubCopilotAuth.getCopilotEndpoint()

        // Handle streaming vs non-streaming requests
        if (anthropicRequest.stream) {
          return handleStreamingRequest(c, openAIRequest, anthropicRequest, token, endpoint, deps)
        } else {
          return handleNonStreamingRequest(c, openAIRequest, token, endpoint, deps)
        }
      } catch (error) {
        logger.error('COPILOT_API', `API request failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
        const errorResponse = createAPIErrorResponse(
          error instanceof Error ? error.message : "Failed to process request",
          "api_error",
          "REQUEST_FAILED"
        )
        return c.json(errorResponse, 500)
      }
    } catch (error) {
      logger.error('ANTHROPIC_REQUEST', `Request parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
      const errorResponse = createAPIErrorResponse(
        "Invalid JSON in request body",
        "invalid_request_error",
        "INVALID_JSON"
      )
      return c.json(errorResponse, 400)
    }
  })

  return app
}

/**
 * Handle non-streaming Anthropic messages requests
 */
async function handleNonStreamingRequest(
  c: Context,
  openAIRequest: any,
  token: string,
  endpoint: string,
  deps: MessagesRouteDependencies
): Promise<Response> {
  try {
    // Use ChatService to forward to GitHub Copilot (OpenAI format)
    const openAIResponse = await deps.chatService.forwardToCopilot(token, openAIRequest, endpoint)
    
    // Transform OpenAI response to Anthropic format
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const anthropicResponse = anthropicTransformService.transformOpenAIToAnthropic(openAIResponse, messageId)
    
    const res = c.json(anthropicResponse)
    res.headers.set('Content-Type', 'application/json; charset=UTF-8')
    return res
  } catch (e: any) {
    if (e?.message === 'QUEUE_SATURATED') {
      const errorResponse = createAPIErrorResponse(
        'Server overloaded',
        'server_overloaded',
        'QUEUE_SATURATED'
      )
      return c.json(errorResponse, 503)
    }
    if (e?.message === 'QUEUE_TIMEOUT') {
      const errorResponse = createAPIErrorResponse(
        'Upstream busy',
        'upstream_busy',
        'QUEUE_TIMEOUT'
      )
      return c.json(errorResponse, 504)
    }
    throw e
  }
}

/**
 * Handle streaming Anthropic messages requests
 */
async function handleStreamingRequest(
  c: Context,
  openAIRequest: any,
  anthropicRequest: any,
  token: string,
  endpoint: string,
  deps: MessagesRouteDependencies
): Promise<Response> {
  // Check capacity
  const metrics = deps.streamMonitor.getMetrics()
  const activeCount = deps.streamMonitor.getActiveStreamCount()
  
  if (activeCount >= deps.maxConcurrentStreams) {
    const errorResponse = createAPIErrorResponse(
      "Server is at maximum capacity for streaming requests. Please try again later.",
      "capacity_error",
      "max_streams_exceeded"
    )
    return c.json(errorResponse, 503)
  }

  // Lightweight overload guard
  if (metrics.totalRequests - metrics.successfulStreams > deps.maxConcurrentStreams * 4) {
    const errorResponse = createAPIErrorResponse(
      "Server is currently overloaded. Please try again shortly.",
      "server_overloaded",
      "overload_guard"
    )
    return c.json(errorResponse, 503)
  }

  // Generate message ID for the stream
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  const model = anthropicRequest.model || 'gpt-4'

  // Use Hono's streamSSE for streaming responses with Anthropic format
  return streamSSE(c, async (stream) => {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    const startTime = Date.now()

    deps.streamMonitor.trackStream(streamId)

    try {
      // Import streaming utilities
      const { StreamingErrorBoundary } = await import("../utils/errorBoundary.js")
      const { streamCoordinator } = await import("../utils/streamCoordinator.js")
      const { streamLogger } = await import("../utils/logger.js")

      // Register with global coordinator
      streamCoordinator.registerStream(streamId)
      streamCoordinator.markLayerActive(streamId, 'serverCleanup')
      streamCoordinator.registerCleanupCallback(streamId, () => {
        deps.streamMonitor.cleanupStream(streamId, 'coordinator callback')
      })

      // Create wrapped stream that transforms OpenAI format to Anthropic format
      const wrappedStream = createAnthropicStreamWrapper(stream, messageId, model)

      // Wrap streaming operation in error boundary
      const result = await StreamingErrorBoundary.handleStreamingOperation(
        async () => {
          // Use ChatService for streaming with wrapped stream
          await deps.chatService.forwardToCopilotStreaming(token, openAIRequest, endpoint, wrappedStream, streamId)
        },
        streamId,
        {
          retryAttempts: 1,
          retryDelay: 1000,
          timeoutMs: deps.isTestEnvironment ? 30000 : 60000,
          category: 'STREAMING'
        }
      )

      const duration = Date.now() - startTime

      if (result.success) {
        deps.streamMonitor.updateStreamMetrics(streamId, true, duration)
        streamLogger.complete({
          streamId,
          chunkCount: 0,
          duration,
          startTime
        })
      } else {
        deps.streamMonitor.updateStreamMetrics(streamId, false, duration)

        const streamingError = result.error || StreamingErrorBoundary.createStreamingError(
          'STREAM_FAILED',
          'Streaming operation failed after retries',
          streamId
        )

        logger.error('STREAM', `💥 Anthropic streaming error in ${streamId}: ${streamingError.message}`)
      }
    } finally {
      const { streamCoordinator } = await import("../utils/streamCoordinator.js")
      await streamCoordinator.initiateCleanup(streamId, 'finally block', 'server')
    }
  })
}

