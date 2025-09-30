import { Hono, Context } from "hono"
import { streamSSE } from "hono/streaming"
import { GitHubCopilotAuth } from "../auth.js"
import {
  ChatCompletionRequest,
} from "../types.js"
import { createAPIErrorResponse } from "../types/errors.js"
import { logRoleNormalizationStats } from "../utils/roleNormalization.js"
import { getContentStats } from "../utils/content.js"
import { logger } from "../utils/logger.js"
import { config } from "../config/index.js"
import { ChatService } from "../services/chat/chatService.js"
import { StreamMonitorService } from "../services/streamMonitorService.js"

/**
 * Chat completions route handlers
 * Provides the main chat completions endpoint with streaming and non-streaming support
 */

export interface ChatRouteDependencies {
  chatService: ChatService
  streamMonitor: StreamMonitorService
  maxConcurrentStreams: number
  isTestEnvironment: boolean
}

/**
 * Create chat routes
 * @param deps - Dependencies required by chat routes (ChatService, StreamMonitorService, etc.)
 */
export function createChatRoutes(deps: ChatRouteDependencies): Hono {
  const app = new Hono()

  /**
   * Handle unsupported HTTP methods for chat completions endpoint
   */
  app.all("/chat/completions", async (c, next): Promise<Response | void> => {
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
   * POST /v1/chat/completions - OpenAI-compatible chat completions endpoint
   * Supports both streaming and non-streaming requests
   */
  app.post("/chat/completions", async (c) => {
    // Use already-parsed body from requestSize middleware
    const parsedBody = (c as any).get('parsedBody')

    if (!parsedBody) {
      const errorResponse = createAPIErrorResponse(
        "Request body could not be parsed",
        "invalid_request_error",
        "MISSING_PARSED_BODY"
      )
      return c.json(errorResponse, 400)
    }

    // Validate the parsed body using Zod schema
    const validationResult = ChatCompletionRequest.safeParse(parsedBody)

    if (!validationResult.success) {
      const issues = validationResult.error.issues

      // Log detailed validation errors for debugging (especially role issues)
      issues.forEach(issue => {
        if (issue.path.includes('role')) {
          logger.warn('VALIDATION', `Role validation failed:`, {
            path: issue.path.join('.'),
            message: issue.message,
            expected: 'system | user | assistant',
            code: issue.code
          })
        }
      })

      const errorMessage = issues.map(issue => {
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

    const body = validationResult.data

    // Log role normalization statistics in development
    if (config.environment === 'development') {
      logRoleNormalizationStats(body.messages)

      // Optional: Log content statistics for debugging (only for first message)
      if (body.messages.length > 0) {
        const firstMessage = body.messages[0]
        const stats = getContentStats(firstMessage.content)
        if (stats.type === "array") {
          logger.debug('CONTENT', `📝 First message: ${stats.textBlocks} text block(s), ${stats.imageBlocks} image(s), ${stats.totalLength} chars`)
        }
      }
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

    try {
      // Get the dynamic Copilot endpoint
      const endpoint = await GitHubCopilotAuth.getCopilotEndpoint()

      // Handle streaming vs non-streaming requests
      if (body.stream) {
        return handleStreamingRequest(c, body, token, endpoint, deps)
      } else {
        return handleNonStreamingRequest(c, body, token, endpoint, deps)
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
  })

  return app
}

/**
 * Handle streaming chat completion requests
 */
async function handleStreamingRequest(
  c: Context,
  body: ChatCompletionRequest,
  token: string,
  endpoint: string,
  deps: ChatRouteDependencies
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

  // Lightweight overload guard to shed load before admission
  if (metrics.totalRequests - metrics.successfulStreams > deps.maxConcurrentStreams * 4) {
    const errorResponse = createAPIErrorResponse(
      "Server is currently overloaded. Please try again shortly.",
      "server_overloaded",
      "overload_guard"
    )
    return c.json(errorResponse, 503)
  }

  // Apply ping handling logic
  const effectiveBody = applyPingHandling(body)

  // Use Hono's streamSSE for streaming responses
  return streamSSE(c, async (stream) => {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    const startTime = Date.now()

    deps.streamMonitor.trackStream(streamId)

    try {
      // Import here to avoid circular dependencies
      const { StreamingErrorBoundary } = await import("../utils/errorBoundary.js")
      const { streamCoordinator } = await import("../utils/streamCoordinator.js")
      const { streamLogger } = await import("../utils/logger.js")

      // Register with global coordinator
      streamCoordinator.registerStream(streamId)
      streamCoordinator.markLayerActive(streamId, 'serverCleanup')
      streamCoordinator.registerCleanupCallback(streamId, () => {
        deps.streamMonitor.cleanupStream(streamId, 'coordinator callback')
      })

      // Wrap streaming operation in error boundary
      const result = await StreamingErrorBoundary.handleStreamingOperation(
        async () => {
          // Use ChatService for streaming (business logic fully extracted)
          await deps.chatService.forwardToCopilotStreaming(token, effectiveBody, endpoint, stream, streamId)
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

        // Log streaming error
        logger.error('STREAM', `💥 Streaming error in streaming-boundary-${streamId}: ${streamingError.message}`)
      }
    } finally {
      // Import here to avoid circular dependencies
      const { streamCoordinator } = await import("../utils/streamCoordinator.js")
      await streamCoordinator.initiateCleanup(streamId, 'finally block', 'server')
    }
  })
}

/**
 * Handle non-streaming chat completion requests
 */
async function handleNonStreamingRequest(
  c: Context,
  body: ChatCompletionRequest,
  token: string,
  endpoint: string,
  deps: ChatRouteDependencies
): Promise<Response> {
  try {
    // Use ChatService for non-streaming requests (business logic fully extracted)
    const copilotResponse = await deps.chatService.forwardToCopilot(token, body, endpoint)
    const res = c.json(copilotResponse)
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
 * Apply intelligent ping handling to the request
 */
function applyPingHandling(body: ChatCompletionRequest): ChatCompletionRequest {
  const pingHandling = String(process.env.PING_HANDLING ?? 'off').toLowerCase() as 'off' | 'suppress' | 'enhance'
  const MIN_STREAM_TOKENS = Number(process.env.PING_MIN_TOKENS ?? process.env.STREAM_MIN_TOKENS ?? 4)
  const effectiveBody: ChatCompletionRequest = { ...body }

  const isString = (v: unknown): v is string => typeof v === 'string'
  const normalize = (s: string) => s.trim().toLowerCase()
  const smallPingSet = new Set(['ping', 'hello', 'hi', 'hey', 'test', 'ok'])

  const extractPlainText = (msg: any): string => {
    const content = msg?.content
    if (isString(content)) return content
    if (Array.isArray(content)) {
      const t = content.find((b: any) => isString(b?.text))
      if (t && isString(t.text)) return t.text
    }
    return ''
  }

  const isStreamingReq = effectiveBody?.stream === true

  const isLikelyPing = (() => {
    try {
      // STRICT: only consider streaming, temp=0, and single short user message
      if (!isStreamingReq) return false
      if ((effectiveBody.temperature ?? null) !== 0) return false
      if (!Array.isArray(effectiveBody.messages) || effectiveBody.messages.length !== 1) return false
      const m = effectiveBody.messages[0]
      if (!m || (m as any).role !== 'user') return false

      const text = normalize(extractPlainText(m))
      if (!text) return false

      // Heuristics: very short and simple
      const shortEnough = text.length <= 6 && text.split(/\s+/).length <= 2
      if (shortEnough && smallPingSet.has(text)) return true
      return false
    } catch {
      return false
    }
  })()

  // Handle ping according to PING_HANDLING
  if (pingHandling === 'off' && isLikelyPing) {
    try {
      const m = Array.isArray(effectiveBody.messages) ? (effectiveBody.messages as any[])[0] : null
      const pingText = m ? normalize(extractPlainText(m)) : ''
      logger.info('PING', `Detected ping-style request (handling=off). text="${pingText}" len=${pingText.length} max_tokens=${String(effectiveBody.max_tokens)} stream=${String(effectiveBody.stream)} temp=${String(effectiveBody.temperature)}`)
    } catch { }
  }

  if (pingHandling !== 'off' && isStreamingReq && typeof effectiveBody.max_tokens === 'number' && effectiveBody.max_tokens <= 1 && isLikelyPing) {
    try {
      const m = Array.isArray(effectiveBody.messages) ? (effectiveBody.messages as any[])[0] : null
      const pingText = m ? normalize(extractPlainText(m)) : ''
      logger.info('PING', `Detected ping-style request. mode=${pingHandling} text="${pingText}" len=${pingText.length} original_max_tokens=${String(body.max_tokens ?? 'unset')} stream=${String(effectiveBody.stream)} temp=${String(effectiveBody.temperature)}`)
    } catch { }

    if (pingHandling === 'enhance') {
      const before = effectiveBody.max_tokens
      effectiveBody.max_tokens = Math.max(MIN_STREAM_TOKENS, 2)
      logger.info('PING', `Enhancing ping response: bump max_tokens ${before} -> ${effectiveBody.max_tokens}`)
    }
  }

  return effectiveBody
}
