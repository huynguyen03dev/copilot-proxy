import { Hono } from "hono"
import { serve } from "@hono/node-server"

import { cors } from "hono/cors"
import { logger as honoLogger } from "hono/logger"
import { streamSSE } from "hono/streaming"
import { zValidator } from "@hono/zod-validator"
import { GitHubCopilotAuth } from "./auth.js"
import {
  TIMEOUT_CONSTANTS,
  PERFORMANCE_CONSTANTS,
  HTTP_STATUS,
  ENDPOINT_PATHS,
  ERROR_CODES
} from "./constants/index.js"

import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  ContentBlock,
  ErrorFactory,
  toAPIErrorResponse
} from "./types.js"
import { createAPIErrorResponse } from "./types/errors.js"
import {
  validateContent,
  transformMessagesForCopilot,
  getContentStats
} from "./utils/content.js"
import { logRoleNormalizationStats } from "./utils/roleNormalization.js"
import {
  logger,
  streamLogger,
  endpointLogger,
  modelLogger,
  memoryLogger,
  type EndpointAttempt
} from "./utils/logger.js"
import { config, logConfiguration } from "./config/index.js"
import { securityConfig } from "./config/security.js"
import { correlationMiddleware } from "./middleware/correlation.js"
import { requestSizeMiddleware, TEST_LIMITS, PRODUCTION_LIMITS } from "./middleware/requestSize.js"
import {
  streamingValidationMiddleware,
  TEST_STREAMING_CONFIG,
  PRODUCTION_STREAMING_CONFIG
} from "./middleware/streamingValidation.js"
import {
  compressionMiddleware,
  DEFAULT_COMPRESSION_CONFIG,
  PRODUCTION_COMPRESSION_CONFIG
} from "./middleware/compression.js"
import {
  cacheHeadersMiddleware,
  DEFAULT_CACHE_CONFIG,
  PRODUCTION_CACHE_CONFIG,
  TEST_CACHE_CONFIG
} from "./middleware/cacheHeaders.js"
import {
  initializeBatchLogger,
  PRODUCTION_BATCH_CONFIG,
  DEFAULT_BATCH_CONFIG
} from "./utils/batchLogger.js"
import {
  initializeAsyncLogger,
  PRODUCTION_ASYNC_CONFIG,
  DEFAULT_ASYNC_CONFIG
} from "./utils/asyncLogger.js"
import {
  initializePerformanceLogger,
  getPerformanceLogger
} from "./utils/performanceLogger.js"
import {
  initializeCircuitBreakerManager,
  PRODUCTION_MANAGER_CONFIG,
  DEFAULT_MANAGER_CONFIG
} from "./utils/circuitBreakerManager.js"
import {
  circuitBreakerMiddleware,
  circuitBreakerHealthMiddleware,
  circuitBreakerAdminMiddleware,
  PRODUCTION_CIRCUIT_BREAKER_MIDDLEWARE_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_MIDDLEWARE_CONFIG
} from "./middleware/circuitBreakerMiddleware.js"

import {
  StreamingErrorBoundary,
  NetworkErrorBoundary
} from "./utils/errorBoundary.js"
import { endpointCache } from "./utils/endpointCache.js"
import { connectionPool } from "./utils/connectionPool.js"
import { streamingManager } from "./utils/streamingManager.js"
import { streamCoordinator } from "./utils/streamCoordinator.js"
import { responseCache } from "./utils/responseCache.js"

export class CopilotAPIServer {
  private app: Hono
  private port: number
  private hostname: string

  // Connection management
  private activeStreams = new Set<string>()

  private streamStartTimes = new Map<string, number>()  // Track stream start times for cleanup sweeper
  private streamTimeouts = new Map<string, NodeJS.Timeout>()  // Track stream timeout handles
  private readonly MAX_CONCURRENT_STREAMS = config.server.maxConcurrentStreams

  private readonly IS_TEST_ENVIRONMENT = process.env.NODE_ENV === 'test'
  private readonly STREAM_TIMEOUT_MS = TIMEOUT_CONSTANTS.STREAM_TIMEOUT_MS

  // Performance monitoring
  private streamMetrics = {
    totalRequests: 0,
    successfulStreams: 0,
    failedStreams: 0,
    totalChunks: 0,
    totalBytes: 0,
    averageStreamDuration: 0,
    peakConcurrentStreams: 0,
    startTime: Date.now()
  }

  // Memory management
  private readonly MAX_BUFFER_SIZE = config.streaming.maxBufferSize
  private readonly MEMORY_CHECK_INTERVAL = config.monitoring.memoryCheckInterval
  private memoryMonitor: NodeJS.Timeout | null = null

  // Server instance for graceful shutdown
  private server: any = null

  // PERFORMANCE OPTIMIZATION: Warmup cache to prevent repeated warmups
  // Tracks when each origin was last warmed up to reduce network chatter
  private warmupCache = new Map<string, number>()
  private readonly WARMUP_TTL = 300000 // 5 minutes TTL for warmup cache

  constructor(
    port: number = config.server.port,
    hostname: string = config.server.hostname
  ) {
    this.port = port
    this.hostname = hostname
    this.app = new Hono()

    // Log configuration on startup
    logConfiguration()

    // Initialize advanced logging system
    this.initializeAdvancedLogging()

    this.setupMiddleware()
    this.setupRoutes()
    this.setupConnectionMonitoring()
    this.setupResponseCache()
  }

  /**
   * Initialize advanced logging system
   */
  private initializeAdvancedLogging(): void {
    try {
      // Initialize batch logger
      const batchConfig = this.IS_TEST_ENVIRONMENT ? DEFAULT_BATCH_CONFIG : PRODUCTION_BATCH_CONFIG
      const batchLogger = initializeBatchLogger(batchConfig)

      // Initialize async logger
      const asyncConfig = this.IS_TEST_ENVIRONMENT ? DEFAULT_ASYNC_CONFIG : PRODUCTION_ASYNC_CONFIG
      const asyncLogger = initializeAsyncLogger(asyncConfig)

      // Initialize performance logger
      const performanceLogger = initializePerformanceLogger(asyncLogger)

      // Initialize circuit breaker manager
      const circuitBreakerConfig = this.IS_TEST_ENVIRONMENT ? DEFAULT_MANAGER_CONFIG : PRODUCTION_MANAGER_CONFIG
      const circuitBreakerManager = initializeCircuitBreakerManager(circuitBreakerConfig)

      // HTTP/1.1 server initialization complete

      logger.info('SERVER', '📊 Advanced logging system initialized')
      logger.info('SERVER', `   Batch logging: ${batchConfig.enableFileLogging ? 'enabled' : 'disabled'}`)
      logger.info('SERVER', `   Async queue: ${asyncConfig.enableAsyncQueue ? 'enabled' : 'disabled'}`)
      logger.info('SERVER', `   Performance tracking: ${asyncConfig.enablePerformanceTracking ? 'enabled' : 'disabled'}`)

      logger.info('SERVER', '🔄 Circuit breaker system initialized')
      logger.info('SERVER', `   Global metrics: ${circuitBreakerConfig.enableGlobalMetrics ? 'enabled' : 'disabled'}`)
      logger.info('SERVER', `   Event logging: ${circuitBreakerConfig.enableEventLogging ? 'enabled' : 'disabled'}`)
      logger.info('SERVER', `   Periodic reporting: ${circuitBreakerConfig.enablePeriodicReporting ? 'enabled' : 'disabled'}`)

      logger.info('SERVER', '🚀 HTTP/1.1 server system initialized')
      logger.info('SERVER', `   Protocol: HTTP/1.1`)
      logger.info('SERVER', `   Streaming: enabled`)
      logger.info('SERVER', `   Compression: enabled`)

      // Start periodic performance dashboard
      this.startPerformanceDashboard()

    } catch (error) {
      logger.error('SERVER', `Failed to initialize advanced logging: ${error}`)
    }
  }

  /**
   * Start periodic performance dashboard logging
   */
  private startPerformanceDashboard(): void {
    const performanceLogger = getPerformanceLogger()

    // Log performance dashboard every 5 minutes
    setInterval(async () => {
      try {
        await performanceLogger.logPerformanceDashboard()
      } catch (error) {
        logger.error('SERVER', `Performance dashboard error: ${error}`)
      }
    }, 5 * 60 * 1000) // 5 minutes
  }



  private setupMiddleware() {
    // Enable request correlation tracking (must be first)
    this.app.use("*", correlationMiddleware)

    // Enable CORS with configurable security settings
    this.app.use("*", cors({
      origin: securityConfig.cors.origins,
      credentials: securityConfig.cors.credentials,
      allowMethods: securityConfig.cors.methods,
      allowHeaders: securityConfig.cors.headers,
    }))

    // Request logging (after correlation middleware)
    this.app.use("*", honoLogger())

    // Response compression middleware (early in pipeline for optimal performance)
    if (config.performance.enableCompression) {
      this.app.use("*", compressionMiddleware(
        this.IS_TEST_ENVIRONMENT ? DEFAULT_COMPRESSION_CONFIG : PRODUCTION_COMPRESSION_CONFIG
      ))
      logger.info('SERVER', '🗜️  Response compression enabled')
    }

    // Streaming validation temporarily disabled to avoid full-body buffering
    // this.app.use("*", streamingValidationMiddleware(
    //   this.IS_TEST_ENVIRONMENT ? TEST_STREAMING_CONFIG : PRODUCTION_STREAMING_CONFIG
    // ))

    // Request size validation middleware (after streaming validation, before route handlers)
    this.app.use("*", requestSizeMiddleware(this.IS_TEST_ENVIRONMENT ? TEST_LIMITS : PRODUCTION_LIMITS))

    // Cache headers middleware (for optimal client-side caching)
    this.app.use("*", cacheHeadersMiddleware(
      this.IS_TEST_ENVIRONMENT ? TEST_CACHE_CONFIG : PRODUCTION_CACHE_CONFIG
    ))
    logger.info('SERVER', '📦 Cache headers enabled')

    // Circuit breaker middleware (for fault tolerance)
    this.app.use("*", circuitBreakerMiddleware(
      this.IS_TEST_ENVIRONMENT ? DEFAULT_CIRCUIT_BREAKER_MIDDLEWARE_CONFIG : PRODUCTION_CIRCUIT_BREAKER_MIDDLEWARE_CONFIG
    ))

    // Circuit breaker health and admin endpoints
    this.app.use("*", circuitBreakerHealthMiddleware())
    this.app.use("*", circuitBreakerAdminMiddleware())
    logger.info('SERVER', '🔄 Circuit breaker middleware enabled')

    // HTTP/1.1 server ready
    logger.info('SERVER', '🚀 HTTP/1.1 server endpoints enabled')

    // Error handler
    this.app.onError((err, c) => {
      logger.error('SERVER', `Server error: ${err.message}`)

      // Create typed error
      const serverError = ErrorFactory.server(
        'INTERNAL_ERROR',
        err.message || "Internal server error",
        c.req.path,
        c.req.method
      )

      // Convert to API response format
      const errorResponse = toAPIErrorResponse(serverError)
      return c.json(errorResponse, 500)
    })

    // 404 handler for unmatched routes
    this.app.notFound((c) => {
      const errorResponse = createAPIErrorResponse(
        `Endpoint not found: ${c.req.method} ${c.req.path}`,
        "not_found_error",
        "ENDPOINT_NOT_FOUND"
      )
      return c.json(errorResponse, 404)
    })
  }

  private setupRoutes() {
    // Health check endpoint
    this.app.get("/", (c) => {
      return c.json({
        status: "healthy",
        service: "GitHub Copilot API Server",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - this.streamMetrics.startTime) / 1000),
        activeStreams: this.activeStreams.size,
        maxStreams: this.MAX_CONCURRENT_STREAMS
      })
    })

    // Metrics endpoint for monitoring
    this.app.get("/metrics", (c) => {
      const uptime = Date.now() - this.streamMetrics.startTime
      const uptimeHours = Math.round(uptime / (1000 * 60 * 60) * 100) / 100

      return c.json({
        uptime: {
          milliseconds: uptime,
          hours: uptimeHours,
          human: this.formatUptime(uptime)
        },
        streams: {
          active: this.activeStreams.size,
          maxConcurrent: this.MAX_CONCURRENT_STREAMS,
          peakConcurrent: this.streamMetrics.peakConcurrentStreams,
          total: this.streamMetrics.totalRequests,
          successful: this.streamMetrics.successfulStreams,
          failed: this.streamMetrics.failedStreams,
          successRate: this.getSuccessRate()
        },
        performance: {
          totalChunks: this.streamMetrics.totalChunks,
          totalBytes: this.streamMetrics.totalBytes,
          averageStreamDuration: Math.round(this.streamMetrics.averageStreamDuration),
          chunksPerSecond: Math.round(this.streamMetrics.totalChunks / (uptime / 1000)),
          bytesPerSecond: Math.round(this.streamMetrics.totalBytes / (uptime / 1000))
        },
        memory: process.memoryUsage(),
        connectionPool: connectionPool.getOverallStats(),
        streamingManager: streamingManager.getStreamingStats(),
        timestamp: new Date().toISOString()
      })
    })

    // PERFORMANCE OPTIMIZATION: Detailed connection pool metrics endpoint
    // Provides detailed pool statistics for performance monitoring and tuning
    this.app.get("/pool/metrics", (c) => {
      const overallStats = connectionPool.getOverallStats()
      const allStats = connectionPool.getStats() as Map<string, any>

      // Convert Map to object for JSON serialization
      const originStats: Record<string, any> = {}
      for (const [origin, stats] of allStats.entries()) {
        originStats[origin] = stats
      }

      // Get response cache stats
      const cacheStats = responseCache.getStats()

      return c.json({
        overall: overallStats,
        byOrigin: originStats,
        responseCache: cacheStats,
        configuration: {
          maxConnections: 10, // From connection pool config
          maxConcurrentRequests: 100, // From connection pool config
          keepAliveTimeout: 60000,
          maxCacheSize: 1000,
          cacheTTL: 60000
        },
        timestamp: new Date().toISOString()
      })
    })

    // Authentication status
    this.app.get("/auth/status", async (c) => {
      const isAuthenticated = await GitHubCopilotAuth.isAuthenticated()
      return c.json({ authenticated: isAuthenticated })
    })

    // Start authentication flow
    this.app.post("/auth/start", async (c) => {
      try {
        const authData = await GitHubCopilotAuth.authorize()
        return c.json({
          device_code: authData.device,
          user_code: authData.user,
          verification_uri: authData.verification,
          interval: authData.interval,
          expires_in: authData.expiry,
          message: `Please visit ${authData.verification} and enter code: ${authData.user}`
        })
      } catch (error) {
        const errorResponse = createAPIErrorResponse(
          error instanceof Error ? error.message : "Authentication failed",
          "auth_error",
          "AUTHENTICATION_FAILED"
        )
        return c.json(errorResponse, 400)
      }
    })

    // Poll for authentication completion
    this.app.post("/auth/poll", async (c) => {
      const body = await c.req.json()
      const deviceCode = body.device_code

      if (!deviceCode) {
        const errorResponse = createAPIErrorResponse(
          "device_code is required",
          "invalid_request_error",
          "MISSING_DEVICE_CODE",
          "device_code"
        )
        return c.json(errorResponse, 400)
      }

      try {
        const result = await GitHubCopilotAuth.poll(deviceCode)
        return c.json({
          status: result.status,
          error: result.error,
          error_description: result.errorDescription
        })
      } catch (error) {
        const errorResponse = createAPIErrorResponse(
          error instanceof Error ? error.message : "Polling failed",
          "auth_error",
          "POLLING_FAILED"
        )
        return c.json(errorResponse, 400)
      }
    })

    // Clear authentication
    this.app.post("/auth/clear", async (c) => {
      await GitHubCopilotAuth.clearAuth()
      return c.json({ message: "Authentication cleared" })
    })

    // Complete authentication flow (alternative to manual polling)
    this.app.post("/auth/complete", async (c) => {
      try {
        const result = await GitHubCopilotAuth.authenticateWithFlow()

        if (result.success) {
          return c.json({
            success: true,
            message: "Authentication completed successfully"
          })
        } else {
          return c.json({
            success: false,
            error: result.error,
            error_description: result.errorDescription,
            message: "Authentication failed"
          }, 400)
        }
      } catch (error) {
        const errorResponse = createAPIErrorResponse(
          error instanceof Error ? error.message : "Authentication flow failed",
          "auth_error",
          "AUTHENTICATION_FLOW_FAILED"
        )
        return c.json(errorResponse, 500)
      }
    })

    // Handle unsupported HTTP methods for chat completions endpoint
    this.app.all("/v1/chat/completions", async (c, next): Promise<Response | void> => {
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

    // OpenAI-compatible chat completions endpoint
    this.app.post(
      "/v1/chat/completions",
      async (c) => {
        // PERFORMANCE OPTIMIZATION: Use already-parsed body from requestSize middleware
        // This eliminates double JSON parsing (requestSize + zValidator)
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
          // COMPATIBILITY FIX: Enhanced error logging for debugging client compatibility issues
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
            // Include path in error message for better debugging
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

        // PERFORMANCE OPTIMIZATION: Content validation moved to Zod schema refinements
        // This eliminates redundant validation work - validation is now handled by zValidator middleware

        // COMPATIBILITY FIX: Log role normalization statistics in development
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

            if (this.activeStreams.size >= this.MAX_CONCURRENT_STREAMS) {
              const errorResponse = createAPIErrorResponse(
                "Server is at maximum capacity for streaming requests. Please try again later.",
                "capacity_error",
                "max_streams_exceeded"
              )
              return c.json(errorResponse, 503)
            }

            // Lightweight overload guard to shed load before admission
            if (this.streamMetrics.totalRequests - this.streamMetrics.successfulStreams > this.MAX_CONCURRENT_STREAMS * 4) {
              const errorResponse = createAPIErrorResponse(
                "Server is currently overloaded. Please try again shortly.",
                "server_overloaded",
                "overload_guard"
              )
              return c.json(errorResponse, 503)
            }

            // Intelligent ping handling (configurable): off | suppress | enhance
            const pingHandling = String(process.env.PING_HANDLING ?? 'off').toLowerCase() as 'off' | 'suppress' | 'enhance'
            const MIN_STREAM_TOKENS = Number(process.env.PING_MIN_TOKENS ?? process.env.STREAM_MIN_TOKENS ?? 4)
            const effectiveBody: typeof body = { ...body }

            const isString = (v: unknown): v is string => typeof v === 'string'
            const normalize = (s: string) => s.trim().toLowerCase()
            const smallPingSet = new Set(['ping','hello','hi','hey','test','ok'])

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
              } catch { return false }
            })()

            // Handle ping according to PING_HANDLING
            // If handling is off but a ping is detected, log at INFO and proceed unchanged
            if (pingHandling === 'off' && isLikelyPing) {
              try {
                const m = Array.isArray(effectiveBody.messages) ? (effectiveBody.messages as any[])[0] : null
                const pingText = m ? normalize(extractPlainText(m)) : ''
                logger.info('PING', `Detected ping-style request (handling=off). text="${pingText}" len=${pingText.length} max_tokens=${String(effectiveBody.max_tokens)} stream=${String(effectiveBody.stream)} temp=${String(effectiveBody.temperature)}`)
              } catch {}
            }

            if (pingHandling !== 'off' && isStreamingReq && typeof effectiveBody.max_tokens === 'number' && effectiveBody.max_tokens <= 1 && isLikelyPing) {
              try {
                const m = Array.isArray(effectiveBody.messages) ? (effectiveBody.messages as any[])[0] : null
                const pingText = m ? normalize(extractPlainText(m)) : ''
                logger.info('PING', `Detected ping-style request. mode=${pingHandling} text="${pingText}" len=${pingText.length} original_max_tokens=${String(body.max_tokens ?? 'unset')} stream=${String(effectiveBody.stream)} temp=${String(effectiveBody.temperature)}`)
              } catch {}

              if (pingHandling === 'suppress') {
                // Short-circuit: do not call upstream, emit DONE immediately
                return streamSSE(c, async (stream) => {
                  const streamId = `stream-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
                  this.trackStream(streamId)
                  // Register with coordinator for proper lifecycle
                  streamCoordinator.registerStream(streamId)
                  streamCoordinator.markLayerActive(streamId, 'serverCleanup')
                  streamCoordinator.registerCleanupCallback(streamId, () => {
                    this.cleanupStreamGuaranteed(streamId, 'ping suppress')
                  })
                  logger.info('PING', 'Suppressing ping response: streaming [DONE]')
                  await stream.writeSSE({ data: '[DONE]' })
                  await streamCoordinator.initiateCleanup(streamId, 'ping suppress done', 'server')
                })
              } else if (pingHandling === 'enhance') {
                const before = effectiveBody.max_tokens
                effectiveBody.max_tokens = Math.max(MIN_STREAM_TOKENS, 2)
                logger.info('PING', `Enhancing ping response: bump max_tokens ${before} -> ${effectiveBody.max_tokens}`)
              }
            }

            // Use Hono's streamSSE for streaming responses with error boundaries
            return streamSSE(c, async (stream) => {
              const streamId = `stream-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
              const startTime = Date.now()

              // PERFORMANCE OPTIMIZATION: Guaranteed stream cleanup with try/finally
              // Prevents memory leaks from abandoned streams
              this.trackStream(streamId)

              // Register with global coordinator
              streamCoordinator.registerStream(streamId)
              streamCoordinator.markLayerActive(streamId, 'serverCleanup')
              streamCoordinator.registerCleanupCallback(streamId, () => {
                this.cleanupStreamGuaranteed(streamId, 'coordinator callback')
              })

              try {
                // Wrap streaming operation in error boundary
                const result = await StreamingErrorBoundary.handleStreamingOperation(
                  async () => {
                    await this.forwardToCopilotStreaming(token, effectiveBody, endpoint, stream, streamId)
                  },
                  streamId,
                  {
                    retryAttempts: 1,
                    retryDelay: 1000,
                    timeoutMs: this.IS_TEST_ENVIRONMENT ? 30000 : 60000, // 30s for tests, 60s for production
                    category: 'STREAMING'
                  }
                )

                const duration = Date.now() - startTime

                if (result.success) {
                  this.updateStreamMetrics(streamId, true, duration)
                  streamLogger.complete({
                    streamId,
                    chunkCount: 0, // Will be updated by the streaming method
                    duration,
                    startTime
                  })
                } else {
                  this.updateStreamMetrics(streamId, false, duration)

                  // Handle streaming error with proper error boundary
                  const streamingError = result.error || StreamingErrorBoundary.createStreamingError(
                    'STREAM_FAILED',
                    'Streaming operation failed after retries',
                    streamId
                  )

                  await this.handleStreamingError(
                    stream,
                    new Error(streamingError.message),
                    `streaming-boundary-${streamId}`
                  )
                }
              } finally {
                // GUARANTEED CLEANUP: Use coordinator for final cleanup
                // This prevents memory leaks and coordinates with all other cleanup paths
                await streamCoordinator.initiateCleanup(streamId, 'finally block', 'server')
              }
            })
          } else {
            // Forward request to GitHub Copilot API (non-streaming)
            try {
              const copilotResponse = await this.forwardToCopilot(token, body, endpoint)
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
        } catch (error) {
          logger.error('COPILOT_API', `API request failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
          const errorResponse = createAPIErrorResponse(
            error instanceof Error ? error.message : "Failed to process request",
            "api_error",
            "REQUEST_FAILED"
          )
          return c.json(errorResponse, 500)
        }
      }
    )

    // List available models (mock response for compatibility)
    this.app.get("/v1/models", async (c) => {
      const isAuthenticated = await GitHubCopilotAuth.isAuthenticated()

      if (!isAuthenticated) {
        const errorResponse = createAPIErrorResponse(
          "Not authenticated",
          "authentication_error",
          "UNAUTHENTICATED"
        )
        return c.json(errorResponse, 401)
      }

      return c.json({
        object: "list",
        data: [
          {
            id: "gpt-4o",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          },
          {
            id: "gpt-4.1",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          },
          {
            id: "claude-sonnet-4",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          },
          {
            id: "gemini-2.0-flash-001",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          },
          {
            id: "gpt-5-mini",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          },
          {
            id: "o4-mini",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          },
          {
            id: "o3-mini",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          },
          {
            id: "gemini-2.5-pro",
            object: "model",
            created: Date.now(),
            owned_by: "github-copilot"
          }
        ]
      })
    })
  }

  /**
   * Optimized endpoint discovery using cache
   */
  private async discoverOptimalEndpoint(
    token: string,
    request: ChatCompletionRequest,
    baseEndpoint: string
  ): Promise<{ url: string, requestBody: any }> {
    // Check cache first
    const cachedEndpoint = endpointCache.getBestEndpoint(baseEndpoint, request.model)

    if (cachedEndpoint) {
      const requestBody = this.buildRequestBody(request, cachedEndpoint.format)
      return {
        url: cachedEndpoint.url,
        requestBody
      }
    }

    // Fallback to discovery if no cache hit
    return this.performEndpointDiscovery(token, request, baseEndpoint)
  }

  /**
   * Build request body based on format
   */
  private buildRequestBody(request: ChatCompletionRequest, format: number): any {
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
   * PERFORMANCE OPTIMIZATION: Eliminates N+1 sequential discovery problem
   * Uses Promise.allSettled with AbortController to cancel losing attempts
   */
  private async performEndpointDiscovery(
    token: string,
    request: ChatCompletionRequest,
    baseEndpoint: string
  ): Promise<{ url: string, requestBody: any }> {
    const configs = endpointCache.getEndpointConfigs()

    // Create AbortController for each endpoint attempt (parallel discovery optimization)
    const controllers = configs.map(() => new AbortController())

    // Build request data for each endpoint configuration
    const endpointAttempts = configs.map((config, index) => {
      const url = `${baseEndpoint}${config.path}`
      const requestBody = { model: request.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0, stream: false }

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
          return { url: attempt.url, requestBody: actualRequestBody }
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

  private async forwardToCopilot(token: string, request: ChatCompletionRequest, endpoint: string): Promise<ChatCompletionResponse> {
    logger.debug('COPILOT_REQUEST', `Transformed ${request.messages.length} message(s) for Copilot compatibility`)

    // PERFORMANCE OPTIMIZATION: Check response cache first
    // Reduces redundant upstream calls for identical requests
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
      // PERFORMANCE OPTIMIZATION: Deduplicate identical in-flight requests
      // Prevents multiple identical requests from hitting upstream simultaneously
      return await responseCache.deduplicateRequest(
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        false, // non-streaming
        async () => {
          // Use optimized endpoint discovery
          const { url, requestBody } = await this.discoverOptimalEndpoint(token, request, endpoint)

      // PERFORMANCE OPTIMIZATION: Smart warmup with TTL to prevent repeated warmups
      // Only warms up connections once per origin within TTL period to reduce network chatter
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

            const transformedResponse = this.transformCopilotResponse(copilotResponse, request)

            // PERFORMANCE OPTIMIZATION: Cache successful response
            // Reduces redundant upstream calls for identical future requests
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
      ) // End deduplicateRequest
    } catch (error) {
      if (error instanceof Error && (error.message === 'QUEUE_SATURATED' || error.message === 'QUEUE_TIMEOUT')) {
        // Preserve queue errors for caller to map to 503/504
        throw error
      }
      logger.error('ENDPOINT', `❌ All endpoint attempts failed: ${error}`)
      throw new Error(`All Copilot API endpoints failed. Error: ${error instanceof Error ? error.message : "Unknown error"}`)
    }
  }

  private transformCopilotResponse(copilotResponse: unknown, request: ChatCompletionRequest): ChatCompletionResponse {
    // Type guard and safe property access
    const response = copilotResponse as Record<string, unknown>
    const responseId = typeof response?.id === 'string' ? response.id : `chatcmpl-${Date.now()}`
    const responseCreated = typeof response?.created === 'number' ? response.created : Math.floor(Date.now() / 1000)
    const responseChoices = Array.isArray(response?.choices) ? response.choices : []
    const responseUsage = response?.usage && typeof response.usage === 'object' ? response.usage as Record<string, unknown> : undefined

    // Extract content from various possible response formats
    let content = "No response from Copilot"
    if (typeof response?.content === 'string') {
      content = response.content
    } else if (response?.message && typeof response.message === 'object') {
      const message = response.message as Record<string, unknown>
      if (typeof message?.content === 'string') {
        content = message.content
      }
    } else if (responseChoices.length > 0) {
      const firstChoice = responseChoices[0] as Record<string, unknown>
      if (firstChoice?.message && typeof firstChoice.message === 'object') {
        const message = firstChoice.message as Record<string, unknown>
        if (typeof message?.content === 'string') {
          content = message.content
        }
      }
    }

    // Transform response to OpenAI format
    const openAIResponse: ChatCompletionResponse = {
      id: responseId,
      object: "chat.completion",
      created: responseCreated,
      model: request.model,
      choices: responseChoices.length > 0 ? responseChoices.map((choice, index) => {
        const choiceObj = choice as Record<string, unknown>
        return {
          index,
          message: {
            role: "assistant",
            content: typeof choiceObj?.message === 'object' && choiceObj.message !== null
              ? (choiceObj.message as Record<string, unknown>)?.content as string || content
              : content
          },
          finish_reason: typeof choiceObj?.finish_reason === 'string' ? choiceObj.finish_reason : "stop"
        }
      }) : [{
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }],
      usage: responseUsage ? {
        prompt_tokens: typeof responseUsage.prompt_tokens === 'number' ? responseUsage.prompt_tokens : 0,
        completion_tokens: typeof responseUsage.completion_tokens === 'number' ? responseUsage.completion_tokens : 0,
        total_tokens: typeof responseUsage.total_tokens === 'number' ? responseUsage.total_tokens : 0
      } : undefined
    }

    return openAIResponse
  }

  private async forwardToCopilotStreaming(
    token: string,
    request: ChatCompletionRequest,
    endpoint: string,
    stream: any,
    streamId: string
  ): Promise<void> {
    logger.debug('STREAM', `🔄 Starting streaming request ${streamId}`)

    // Set up timeout for the entire streaming request
    const streamTimeout = this.setupStreamTimeout(stream, streamId, 300000) // 5 minutes

    try {
      // PERFORMANCE OPTIMIZATION: Use unified endpoint discovery with caching
      // Reuses the same endpoint discovery logic as non-streaming requests
      const { url, requestBody } = await this.discoverOptimalEndpoint(token, request, endpoint)

      // Ensure streaming is enabled in the request body
      const streamingRequestBody = {
        ...requestBody,
        stream: true
      }

      logger.debug('STREAM', `🔄 Using cached/discovered endpoint: ${url}`)
      logger.debug('STREAM', `🔄 Streaming request body: ${JSON.stringify(streamingRequestBody, null, 2)}`)

      // PERFORMANCE OPTIMIZATION: Use pooled connection for streaming
      // Benefits from connection reuse, concurrency limits, timeouts, and circuit breaker
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
        // PERFORMANCE OPTIMIZATION: Smart warmup with TTL to prevent repeated warmups
        // Only warms up connections once per origin within TTL period to reduce network chatter
        const urlObj = new URL(url)
        const origin = `${urlObj.protocol}//${urlObj.host}`
        void this.smartWarmupConnections(origin, 2).catch(() => {
          // Warmup is best-effort, don't fail the main request
        })

        logger.info('STREAM', `✅ Streaming success: ${url} (${response.responseTime}ms)`)

        // Create a Response object compatible with processStreamingResponseUnified
        const fetchResponse = new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as HeadersInit
        })

        await this.processStreamingResponseUnified(fetchResponse, stream, request, streamId, url, true)
        clearTimeout(streamTimeout)
        logger.info('STREAM', `🎉 Streaming request ${streamId} completed successfully`)
        return
      } else {
        throw new Error(`HTTP ${response.statusCode}: Streaming request failed`)
      }
    } catch (error) {
      clearTimeout(streamTimeout)
      const streamError = error instanceof Error ? error : new Error("Unknown streaming error")
      await this.handleStreamingError(stream, streamError, `streaming-${streamId}`)
      throw streamError
    }
  }

  /**
   * PERFORMANCE OPTIMIZATION: Unified streaming response processing
   * Consolidates both streaming implementations with configurable optimizations
   */
  private async processStreamingResponseUnified(
    response: Response,
    stream: any,
    request: ChatCompletionRequest,
    streamId: string,
    apiUrl?: string,
    useOptimizations: boolean = true
  ): Promise<void> {
    const startTime = Date.now()

    if (!response.body) {
      throw new Error("No response body available")
    }

    // PERFORMANCE OPTIMIZATION: Use Transform streams for efficient processing
    let reader: ReadableStreamDefaultReader<Uint8Array>

    if (useOptimizations) {
      try {
        // Try to use optimized streaming manager
        const optimizedStream = await streamingManager.startStream(streamId, response.body)
        reader = optimizedStream.getReader()
      } catch (error) {
        logger.warn('STREAMING_UNIFIED', `Failed to create optimized stream for ${streamId}, falling back to basic: ${error}`)
        reader = response.body.getReader()
      }
    } else {
      reader = response.body.getReader()
      streamCoordinator.registerReader(streamId, reader)
    }

    const decoder = new TextDecoder()
    let buffer = Buffer.alloc(0) // PERFORMANCE OPTIMIZATION: Use Buffer instead of string
    let chunkCount = 0
    let lastActivityTime = Date.now()
    let actualModel: string | null = null
    let modelLogged = false
    const CHUNK_TIMEOUT = 30000 // 30 seconds between chunks

    // Handle client abort with guaranteed cleanup
    let isAborted = false
    let isTimedOut = false
    stream.onAbort(() => {
      logger.info('STREAM', `Client aborted streaming request ${streamId}`)
      isAborted = true
      // Release the local reader lock if present (safe and prevents leaks)
      try { reader.releaseLock() } catch {}
      // Use coordinator for abort cleanup
      streamCoordinator.initiateCleanup(streamId, 'client abort (unified)', 'server-unified')
    })

    // STABILITY FIX: Set up chunk timeout monitoring without throwing inside setInterval
    // Use flag-based approach to avoid unhandled exceptions
    const chunkTimeoutInterval = setInterval(() => {
      if (Date.now() - lastActivityTime > CHUNK_TIMEOUT) {
        logger.warn('STREAM', `⏰ Chunk timeout for stream ${streamId}, last activity: ${Date.now() - lastActivityTime}ms ago`)
        isTimedOut = true
        clearInterval(chunkTimeoutInterval)
        // Don't throw here - let the main loop handle the timeout gracefully
      }
    }, 5000) // Check every 5 seconds

    try {
      while (true) {
        if (isAborted) {
          logger.debug('STREAM', `🚫 Stream ${streamId} was aborted, stopping processing`)
          break
        }

        if (isTimedOut) {
          logger.error('STREAM', `⏰ Stream ${streamId} timed out - no data received for 30 seconds`)
          throw new Error("Streaming chunk timeout - no data received for 30 seconds")
        }

        const { done, value } = await reader.read()
        if (done) {
          const duration = Date.now() - startTime

          // Log completion with metrics
          streamLogger.complete({
            streamId,
            chunkCount,
            model: actualModel || undefined,
            duration
          })

          // PERFORMANCE OPTIMIZATION: Sample streaming performance logs to reduce I/O overhead
          // Log metrics for every 5th stream to avoid excessive logging under load
          if (useOptimizations && Math.random() < 0.2) {
            const streamMetrics = streamingManager.getStreamMetrics(streamId)
            if (streamMetrics) {
              logger.info('STREAMING_PERFORMANCE',
                `Stream ${streamId} metrics: ${streamMetrics.processingRate.toFixed(1)} chunks/sec, ` +
                `${streamMetrics.backpressureEvents} backpressure events, ` +
                `${(streamMetrics.bytesProcessed / 1024).toFixed(1)}KB processed`
              )
            }
          }
          break
        }

        // PERFORMANCE OPTIMIZATION: Efficient buffer management
        buffer = Buffer.concat([buffer, Buffer.from(value)])
        lastActivityTime = Date.now()

        // Process complete lines from buffer
        const { completeLines, remainingBuffer } = this.extractCompleteLines(buffer)
        buffer = remainingBuffer as Buffer<ArrayBuffer>

        for (const line of completeLines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              await stream.writeSSE({ data: '[DONE]' })

              // STABILITY FIX: Use coordinator for [DONE] cleanup to prevent race conditions
              // This ensures proper coordination between all cleanup paths
              console.log(`✅ Stream ${streamId} finished with [DONE] signal${actualModel ? ` (model: ${actualModel})` : ''}`)
              await streamCoordinator.initiateCleanup(streamId, 'done signal', 'server-unified')
              return
            }

            // Process chunk with error boundary
            const chunkResult = StreamingErrorBoundary.handleChunkProcessing(
              () => {
                const chunk = JSON.parse(data)

                // Capture the actual model from the first chunk
                if (!modelLogged && chunk.model) {
                  actualModel = chunk.model
                  modelLogger.info(streamId, chunk.model, apiUrl ?? 'unknown')
                  modelLogged = true
                }

                const transformedChunk = this.transformCopilotStreamChunk(chunk, request)
                return {
                  chunk,
                  transformedChunk,
                  chunkData: JSON.stringify(transformedChunk)
                }
              },
              streamId,
              chunkCount
            )

            if (chunkResult.success && chunkResult.data) {
              try {
                // Use appropriate backpressure handling based on optimization level
                if (useOptimizations) {
                  await this.writeWithBackpressureOptimized(stream, chunkResult.data.chunkData, streamId)
                } else {
                  await this.writeWithBackpressure(stream, chunkResult.data.chunkData, streamId)
                }

                chunkCount++
                this.streamMetrics.totalChunks++
                this.streamMetrics.totalBytes += chunkResult.data.chunkData.length
              } catch (writeError) {
                logger.error('STREAM', `💥 Failed to write chunk ${chunkCount} for stream ${streamId}: ${writeError}`)
                throw StreamingErrorBoundary.createStreamingError(
                  'STREAM_FAILED',
                  `Failed to write chunk: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`,
                  streamId,
                  chunkCount
                )
              }
            } else {
              logger.warn('STREAM', `⚠️ Skipping malformed chunk ${chunkCount} for stream ${streamId}`)
              continue
            }

            // PERFORMANCE OPTIMIZATION: Throttle progress logging and gate behind config flag
            // Reduces I/O overhead under load by sampling logs and allowing disable in production
            if (config.logging.enableProgressLogs) {
              const logFrequency = useOptimizations ? 10 : 5
              if (chunkCount % logFrequency === 0) {
                streamLogger.progress({
                  streamId,
                  chunkCount,
                  model: actualModel || undefined,
                  startTime
                })
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`❌ Error processing unified stream ${streamId}:`, error)
      throw error
    } finally {
      clearInterval(chunkTimeoutInterval)
      await streamCoordinator.initiateCleanup(streamId, 'finally (unified)', 'server-unified')
    }
  }

  /**
   * PERFORMANCE OPTIMIZATION: Extract complete lines from buffer efficiently
   * Processes buffer data to find complete lines ending with \n
   */
  private extractCompleteLines(buffer: Buffer): { completeLines: string[]; remainingBuffer: Buffer } {
    const decoder = new TextDecoder()
    const text = decoder.decode(buffer)
    const lines = text.split('\n')

    // Last element might be incomplete if buffer doesn't end with \n
    const remainingText = lines.pop() || ''
    const remainingBuffer = Buffer.from(remainingText)

    return {
      completeLines: lines,
      remainingBuffer
    }
  }

  /**
   * @deprecated Use processStreamingResponseUnified instead
   */
  private async processStreamingResponse(
    response: Response,
    stream: any,
    request: ChatCompletionRequest,
    streamId: string,
    apiUrl?: string
  ): Promise<void> {
    const startTime = Date.now()
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error("No response body reader available")
    }
    streamCoordinator.registerReader(streamId, reader)

    const decoder = new TextDecoder()
    let buffer = ""
    let chunkCount = 0
    let lastActivityTime = Date.now()
    let actualModel: string | null = null
    let modelLogged = false
    const CHUNK_TIMEOUT = 30000 // 30 seconds between chunks

    // Handle client abort
    let isAborted = false
    let isTimedOut = false
    stream.onAbort(() => {
      console.log(`🚫 Client aborted streaming request ${streamId}`)
      isAborted = true
      // Use coordinator for abort cleanup (deprecated path)
      streamCoordinator.initiateCleanup(streamId, 'client abort (deprecated)', 'server-deprecated')
      try { reader.releaseLock() } catch {}
    })

    // STABILITY FIX: Set up chunk timeout monitoring without throwing inside setInterval
    // Use flag-based approach to avoid unhandled exceptions
    const chunkTimeoutInterval = setInterval(() => {
      if (Date.now() - lastActivityTime > CHUNK_TIMEOUT) {
        logger.warn('STREAM', `⏰ Chunk timeout for stream ${streamId}, last activity: ${Date.now() - lastActivityTime}ms ago`)
        isTimedOut = true
        clearInterval(chunkTimeoutInterval)
        // Don't throw here - let the main loop handle the timeout gracefully
      }
    }, 5000) // Check every 5 seconds

    try {
      while (true) {
        if (isAborted) {
          logger.debug('STREAM', `🚫 Stream ${streamId} was aborted, stopping processing`)
          break
        }

        if (isTimedOut) {
          logger.error('STREAM', `⏰ Stream ${streamId} timed out - no data received for 30 seconds`)
          throw new Error("Streaming chunk timeout - no data received for 30 seconds")
        }

        const { done, value } = await reader.read()
        if (done) {
          const duration = Date.now() - startTime
          streamLogger.complete({
            streamId,
            chunkCount,
            model: actualModel || undefined,
            duration
          })
          break
        }

        lastActivityTime = Date.now()

        // PERFORMANCE OPTIMIZATION: Reduce string concatenation churn
        // Use more efficient buffer management to avoid repeated string allocations
        const newData = decoder.decode(value, { stream: true })
        buffer += newData

        // Optimize line parsing to reduce string operations
        let lineStart = 0
        const lines: string[] = []

        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] === '\n') {
            lines.push(buffer.slice(lineStart, i))
            lineStart = i + 1
          }
        }

        // Keep remaining data in buffer (more efficient than split/pop)
        buffer = buffer.slice(lineStart)

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              await stream.writeSSE({ data: '[DONE]' })
              console.log(`✅ Stream ${streamId} finished with [DONE] signal${actualModel ? ` (model: ${actualModel})` : ''}`)
              return
            }

            // Process chunk with error boundary
            const chunkResult = StreamingErrorBoundary.handleChunkProcessing(
              () => {
                const chunk = JSON.parse(data)

                // Capture the actual model from the first chunk
                if (!modelLogged && chunk.model) {
                  actualModel = chunk.model
                  modelLogger.info(streamId, chunk.model, apiUrl ?? 'unknown')
                  modelLogged = true
                }

                const transformedChunk = this.transformCopilotStreamChunk(chunk, request)
                return {
                  chunk,
                  transformedChunk,
                  chunkData: JSON.stringify(transformedChunk)
                }
              },
              streamId,
              chunkCount
            )

            if (chunkResult.success && chunkResult.data) {
              try {
                // Implement backpressure handling with error boundary
                await this.writeWithBackpressure(stream, chunkResult.data.chunkData, streamId)

                chunkCount++
                this.streamMetrics.totalChunks++
                this.streamMetrics.totalBytes += chunkResult.data.chunkData.length
              } catch (writeError) {
                logger.error('STREAM', `💥 Failed to write chunk ${chunkCount} for stream ${streamId}: ${writeError}`)
                throw StreamingErrorBoundary.createStreamingError(
                  'STREAM_FAILED',
                  `Failed to write chunk: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`,
                  streamId,
                  chunkCount
                )
              }
            } else {
              logger.warn('STREAM', `⚠️ Skipping malformed chunk ${chunkCount} for stream ${streamId}`)
              continue
            }

            // PERFORMANCE OPTIMIZATION: Throttle progress logging and gate behind config flag
            // Reduces I/O overhead under load by sampling logs and allowing disable in production
            if (config.logging.enableProgressLogs && chunkCount % 10 === 0) {
              streamLogger.progress({
                streamId,
                chunkCount,
                model: actualModel || undefined,
                startTime
              })
            }
          }
        }
      }
    } catch (error) {
      console.error(`❌ Error processing stream ${streamId}:`, error)
      throw error
    } finally {
      clearInterval(chunkTimeoutInterval)
      await streamCoordinator.initiateCleanup(streamId, 'finally (deprecated)', 'server-deprecated')
    }
  }

  /**
   * Optimized streaming response processing using advanced streaming manager
   */
  private async processStreamingResponseOptimized(
    response: Response,
    stream: any,
    request: ChatCompletionRequest,
    streamId: string,
    apiUrl?: string
  ): Promise<void> {
    const startTime = Date.now()

    if (!response.body) {
      throw new Error("No response body available")
    }

    try {
      // Create optimized stream using streaming manager
      const optimizedStream = await streamingManager.startStream(streamId, response.body)
      const reader = optimizedStream.getReader()
      streamCoordinator.registerReader(streamId, reader)

      const decoder = new TextDecoder()
      let buffer = ""
      let chunkCount = 0
      let lastActivityTime = Date.now()
      let actualModel: string | null = null
      let modelLogged = false
      const CHUNK_TIMEOUT = 30000 // 30 seconds between chunks

      // Handle client abort
      let isAborted = false
      let isTimedOut = false
      stream.onAbort(() => {
        console.log(`🚫 Client aborted streaming request ${streamId}`)
        isAborted = true
        // Use coordinator for abort cleanup (optimized path)
        streamCoordinator.initiateCleanup(streamId, 'client abort (optimized)', 'server-optimized')
        try { reader.releaseLock() } catch {}
      })

      // STABILITY FIX: Set up chunk timeout monitoring without throwing inside setInterval
      // Use flag-based approach to avoid unhandled exceptions
      const chunkTimeoutInterval = setInterval(() => {
        if (Date.now() - lastActivityTime > CHUNK_TIMEOUT) {
          logger.warn('STREAM', `⏰ Chunk timeout for stream ${streamId}, last activity: ${Date.now() - lastActivityTime}ms ago`)
          isTimedOut = true
          clearInterval(chunkTimeoutInterval)
          // Don't throw here - let the main loop handle the timeout gracefully
        }
      }, 5000) // Check every 5 seconds

      try {
        while (true) {
          if (isAborted) {
            logger.debug('STREAM', `🚫 Stream ${streamId} was aborted, stopping processing`)
            break
          }

          if (isTimedOut) {
            logger.error('STREAM', `⏰ Stream ${streamId} timed out - no data received for 30 seconds`)
            throw new Error("Streaming chunk timeout - no data received for 30 seconds")
          }

          const { done, value } = await reader.read()
          if (done) {
            const duration = Date.now() - startTime
            const streamMetrics = streamingManager.getStreamMetrics(streamId)

            streamLogger.complete({
              streamId,
              chunkCount,
              model: actualModel || undefined,
              duration
            })

            // PERFORMANCE OPTIMIZATION: Sample streaming performance logs to reduce I/O overhead
            // Log metrics for every 5th stream to avoid excessive logging under load
            if (streamMetrics && Math.random() < 0.2) {
              logger.info('STREAMING_PERFORMANCE',
                `Stream ${streamId} metrics: ${streamMetrics.processingRate.toFixed(1)} chunks/sec, ` +
                `${streamMetrics.backpressureEvents} backpressure events, ` +
                `${(streamMetrics.bytesProcessed / 1024).toFixed(1)}KB processed`
              )
            }
            break
          }

          lastActivityTime = Date.now()

          // PERFORMANCE OPTIMIZATION: Optimized buffer management (same as fallback method)
          // Use more efficient buffer management to avoid repeated string allocations
          const newData = decoder.decode(value, { stream: true })
          buffer += newData

          // Optimize line parsing to reduce string operations
          let lineStart = 0
          const lines: string[] = []

          for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] === '\n') {
              lines.push(buffer.slice(lineStart, i))
              lineStart = i + 1
            }
          }

          // Keep remaining data in buffer (more efficient than split/pop)
          buffer = buffer.slice(lineStart)

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data === '[DONE]') {
                await stream.writeSSE({ data: '[DONE]' })
                console.log(`✅ Stream ${streamId} finished with [DONE] signal${actualModel ? ` (model: ${actualModel})` : ''}`)
                return
              }

              // Process chunk with error boundary and optimizations
              const chunkResult = StreamingErrorBoundary.handleChunkProcessing(
                () => {
                  const chunk = JSON.parse(data)

                  // Capture the actual model from the first chunk
                  if (!modelLogged && chunk.model) {
                    actualModel = chunk.model
                    modelLogger.info(streamId, chunk.model, apiUrl ?? 'unknown')
                    modelLogged = true
                  }

                  const transformedChunk = this.transformCopilotStreamChunk(chunk, request)
                  return {
                    chunk,
                    transformedChunk,
                    chunkData: JSON.stringify(transformedChunk)
                  }
                },
                streamId,
                chunkCount
              )

              if (chunkResult.success && chunkResult.data) {
                try {
                  // Use optimized backpressure handling
                  await this.writeWithBackpressureOptimized(stream, chunkResult.data.chunkData, streamId)

                  chunkCount++
                  this.streamMetrics.totalChunks++
                  this.streamMetrics.totalBytes += chunkResult.data.chunkData.length
                } catch (writeError) {
                  logger.error('STREAM', `💥 Failed to write chunk ${chunkCount} for stream ${streamId}: ${writeError}`)
                  throw StreamingErrorBoundary.createStreamingError(
                    'STREAM_FAILED',
                    `Failed to write chunk: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`,
                    streamId,
                    chunkCount
                  )
                }
              } else {
                logger.warn('STREAM', `⚠️ Skipping malformed chunk ${chunkCount} for stream ${streamId}`)
                continue
              }

              // PERFORMANCE OPTIMIZATION: Throttle progress logging and gate behind config flag
              // Reduces I/O overhead under load by sampling logs and allowing disable in production
              if (config.logging.enableProgressLogs && chunkCount % 10 === 0) {
                streamLogger.progress({
                  streamId,
                  chunkCount,
                  model: actualModel || undefined,
                  startTime
                })
              }
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error processing optimized stream ${streamId}:`, error)
        throw error
      } finally {
        clearInterval(chunkTimeoutInterval)
        await streamCoordinator.initiateCleanup(streamId, 'finally (optimized)', 'server-optimized')
      }
    } catch (error) {
      logger.error('STREAMING_MANAGER', `Failed to create optimized stream for ${streamId}: ${error}`)
      // Fallback to unified streaming method without optimizations
      await this.processStreamingResponseUnified(response, stream, request, streamId, apiUrl, false)
    }
  }

  private transformCopilotStreamChunk(
    copilotChunk: unknown,
    request: ChatCompletionRequest
  ): ChatCompletionStreamChunk {
    // Type guard and safe property access
    const chunk = copilotChunk as Record<string, unknown>
    const chunkId = typeof chunk?.id === 'string' ? chunk.id : `chatcmpl-${Date.now()}`
    const chunkCreated = typeof chunk?.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000)
    const chunkChoices = Array.isArray(chunk?.choices) ? chunk.choices : []
    const chunkUsage = chunk?.usage && typeof chunk.usage === 'object' ? chunk.usage as Record<string, unknown> : undefined

    return {
      id: chunkId,
      object: "chat.completion.chunk",
      created: chunkCreated,
      model: request.model,
      choices: chunkChoices.length > 0 ? chunkChoices.map((choice, index) => {
        const choiceObj = choice as Record<string, unknown>
        const delta = choiceObj?.delta as Record<string, unknown> | undefined
        // Validate role is one of the allowed values
        const roleValue = typeof delta?.role === 'string' ? delta.role : undefined
        const validRole = roleValue === 'system' || roleValue === 'user' || roleValue === 'assistant' ? roleValue : undefined

        return {
          index: typeof choiceObj?.index === 'number' ? choiceObj.index : index,
          delta: {
            role: validRole,
            content: typeof delta?.content === 'string' ? delta.content : undefined,
          },
          finish_reason: typeof choiceObj?.finish_reason === 'string' ? choiceObj.finish_reason : null,
        }
      }) : [{
        index: 0,
        delta: {
          content: typeof chunk?.content === 'string' ? chunk.content : "",
        },
        finish_reason: null,
      }],
      usage: chunkUsage ? {
        prompt_tokens: typeof chunkUsage.prompt_tokens === 'number' ? chunkUsage.prompt_tokens : 0,
        completion_tokens: typeof chunkUsage.completion_tokens === 'number' ? chunkUsage.completion_tokens : 0,
        total_tokens: typeof chunkUsage.total_tokens === 'number' ? chunkUsage.total_tokens : 0
      } : undefined,
    }
  }

  /**
   * Handle streaming errors by sending error chunk to client
   */
  private async handleStreamingError(
    stream: any,
    error: Error,
    context: string
  ): Promise<void> {
    logger.error('STREAM', `💥 Streaming error in ${context}: ${error.message}`)

    try {
      await stream.writeSSE({
        data: JSON.stringify({
          error: {
            message: error.message,
            type: "stream_error",
            code: "streaming_failed"
          }
        })
      })

      // Send [DONE] to properly close the stream
      await stream.writeSSE({ data: '[DONE]' })
    } catch (writeError) {
      logger.error('STREAM', `💥 Failed to write error to stream in ${context}: ${writeError}`)
    }
  }

  /**
   * Set up timeout for streaming requests
   */
  private setupStreamTimeout(stream: any, streamId: string, timeoutMs: number = 300000): NodeJS.Timeout {
    return setTimeout(async () => {
      logger.warn('STREAM', `⏰ Stream timeout for ${streamId} after ${timeoutMs}ms`)
      await this.handleStreamingError(
        stream,
        new Error(`Stream timeout after ${timeoutMs / 1000} seconds`),
        `timeout-${streamId}`
      )
    }, timeoutMs)
  }

  /**
   * Set up connection monitoring
   */
  private setupConnectionMonitoring(): void {
    // Monitor active streams every minute
    setInterval(() => {
      const currentActive = this.activeStreams.size

      // Update peak concurrent streams
      if (currentActive > this.streamMetrics.peakConcurrentStreams) {
        this.streamMetrics.peakConcurrentStreams = currentActive
      }

      logger.info('MONITOR', `📊 Active streams: ${currentActive}/${this.MAX_CONCURRENT_STREAMS}`)
      logger.info('MONITOR', `📈 Peak concurrent: ${this.streamMetrics.peakConcurrentStreams}`)
      logger.info('MONITOR', `📊 Total requests: ${this.streamMetrics.totalRequests}`)
      logger.info('MONITOR', `✅ Success rate: ${this.getSuccessRate()}%`)


      // PERFORMANCE OPTIMIZATION: Sweep stuck streams to prevent memory leaks
      // Remove streams that have been active longer than the timeout threshold
      this.sweepStuckStreams()
    }, 60000) // Every minute

    // Set up memory monitoring
    this.memoryMonitor = setInterval(() => {
      this.checkMemoryUsage()
    }, this.MEMORY_CHECK_INTERVAL)
  }

  /**
   * Get client identifier for rate limiting
   */

  /**
   * Check streaming rate limit for a client
   */

  /**
   * Track an active streaming connection
   * PERFORMANCE OPTIMIZATION: Track start time for stuck stream detection
   */
  private trackStream(streamId: string): void {
    this.activeStreams.add(streamId)
    this.streamStartTimes.set(streamId, Date.now())  // Track start time for cleanup sweeper
    this.streamMetrics.totalRequests++

    // Set up automatic cleanup timeout as safety net
    const timeoutId = setTimeout(() => {
      logger.warn('STREAM_TIMEOUT', `Stream ${streamId} timed out after ${this.STREAM_TIMEOUT_MS}ms`)
      this.cleanupStreamGuaranteed(streamId, 'timeout')
    }, this.STREAM_TIMEOUT_MS)

    this.streamTimeouts.set(streamId, timeoutId)
    streamLogger.start(streamId, this.activeStreams.size, this.MAX_CONCURRENT_STREAMS)
  }

  /**
   * Untrack a streaming connection
   * PERFORMANCE OPTIMIZATION: Clean up both tracking maps to prevent memory leaks
   */
  private untrackStream(streamId: string): void {
    this.cleanupStreamGuaranteed(streamId, 'normal completion')
  }

  /**
   * PERFORMANCE OPTIMIZATION: Smart warmup with TTL to prevent repeated warmups
   * Only warms up connections once per origin within the TTL period
   */
  private async smartWarmupConnections(origin: string, count: number = 2): Promise<void> {
    const now = Date.now()
    const lastWarmup = this.warmupCache.get(origin)

    // Skip if warmed up recently (within TTL)
    if (lastWarmup && (now - lastWarmup) < this.WARMUP_TTL) {
      logger.debug('WARMUP', `Skipping warmup for ${origin} - warmed up ${Math.round((now - lastWarmup) / 1000)}s ago`)
      return
    }

    // Clean up expired entries while we're here
    for (const [cachedOrigin, timestamp] of this.warmupCache.entries()) {
      if ((now - timestamp) > this.WARMUP_TTL) {
        this.warmupCache.delete(cachedOrigin)
      }
    }

    // Perform warmup and cache the timestamp
    try {
      await connectionPool.warmupConnections(origin, count)
      this.warmupCache.set(origin, now)
      logger.debug('WARMUP', `✅ Warmed up ${count} connections to ${origin}`)
    } catch (error) {
      logger.debug('WARMUP', `⚠️ Warmup failed for ${origin}: ${error}`)
      // Don't cache failed warmups
    }
  }

  /**
   * PERFORMANCE OPTIMIZATION: Guaranteed stream cleanup with comprehensive error handling
   * Ensures all stream-related resources are cleaned up to prevent memory leaks
   */
  private async cleanupStreamGuaranteed(streamId: string, reason: string): Promise<void> {
    try {
      // Always cleanup both tracking maps
      this.activeStreams.delete(streamId)
      this.streamStartTimes.delete(streamId)

      // Clear any associated timeout timers
      const timeoutId = this.streamTimeouts.get(streamId)
      if (timeoutId) {
        clearTimeout(timeoutId)
        this.streamTimeouts.delete(streamId)
      }

      // Update stream metrics
      this.streamMetrics.totalRequests = Math.max(0, this.streamMetrics.totalRequests)

      // Log cleanup with reason
      streamLogger.end(streamId, this.activeStreams.size, this.MAX_CONCURRENT_STREAMS)
      logger.debug('STREAM_CLEANUP', `Stream ${streamId} cleaned up: ${reason}`)

    } catch (error) {
      // Even if cleanup fails, ensure critical maps are cleared
      this.activeStreams.delete(streamId)
      this.streamStartTimes.delete(streamId)
      this.streamTimeouts.delete(streamId)

      logger.error('STREAM_CLEANUP', `Failed to cleanup stream ${streamId}: ${error}`)
    }
  }

  /**
   * Write with backpressure handling
   */
  private async writeWithBackpressure(
    stream: any,
    data: string,
    streamId: string
  ): Promise<void> {
    // Check if data size exceeds buffer limit
    if (data.length > this.MAX_BUFFER_SIZE) {
      console.warn(`⚠️ Large chunk detected in ${streamId}: ${data.length} bytes`)
      // Split large chunks if needed
      const chunks = this.splitLargeChunk(data)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        await stream.writeSSE({ data: chunk })

        // PERFORMANCE OPTIMIZATION: Only delay for very large chunk sequences
        // Removes artificial 1ms delay per chunk that was slowing down streams
        if (chunks.length > 20 && i < chunks.length - 1) {
          // Minimal delay only for extremely large sequences to prevent overwhelming
          await new Promise(resolve => setTimeout(resolve, 0.5))
        }
      }
    } else {
      await stream.writeSSE({ data })
    }
  }

  /**
   * Optimized write with advanced backpressure handling
   */
  private async writeWithBackpressureOptimized(
    stream: any,
    data: string,
    streamId: string
  ): Promise<void> {
    // Get streaming metrics for this stream
    const streamMetrics = streamingManager.getStreamMetrics(streamId)

    // Adaptive chunk sizing based on stream performance
    let effectiveBufferSize = this.MAX_BUFFER_SIZE
    if (streamMetrics) {
      // Reduce buffer size if backpressure events are frequent
      if (streamMetrics.backpressureEvents > 5) {
        effectiveBufferSize = Math.floor(this.MAX_BUFFER_SIZE * 0.7)
      }

      // Increase buffer size for high-performing streams
      if (streamMetrics.processingRate > 10 && streamMetrics.backpressureEvents === 0) {
        effectiveBufferSize = Math.floor(this.MAX_BUFFER_SIZE * 1.3)
      }
    }

    // Check if data size exceeds adaptive buffer limit
    if (data.length > effectiveBufferSize) {
      logger.debug('STREAMING_OPTIMIZED',
        `Large chunk detected in ${streamId}: ${data.length} bytes (limit: ${effectiveBufferSize})`
      )

      // Use optimized chunk splitting
      const chunks = this.splitLargeChunkOptimized(data, effectiveBufferSize)

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        await stream.writeSSE({ data: chunk })

        // PERFORMANCE OPTIMIZATION: Only delay when there's actual backpressure
        // Removes artificial delays that were slowing down healthy streams
        if (streamMetrics && streamMetrics.backpressureEvents > 0) {
          // Longer delay if backpressure is active
          const delay = Math.min(10, streamMetrics.backpressureEvents)
          await new Promise(resolve => setTimeout(resolve, delay))
        } else if (chunks.length > 50 && i < chunks.length - 1) {
          // Very minimal delay only for extremely large chunk sequences
          await new Promise(resolve => setTimeout(resolve, 0.1))
        }
      }
    } else {
      await stream.writeSSE({ data })
    }
  }

  /**
   * Split large chunks into smaller pieces
   */
  private splitLargeChunk(data: string): string[] {
    const chunks: string[] = []
    const maxChunkSize = Math.floor(this.MAX_BUFFER_SIZE / 2) // Use half of max buffer

    for (let i = 0; i < data.length; i += maxChunkSize) {
      chunks.push(data.slice(i, i + maxChunkSize))
    }

    return chunks
  }

  /**
   * Optimized chunk splitting with adaptive sizing
   */
  private splitLargeChunkOptimized(data: string, bufferSize: number): string[] {
    const chunks: string[] = []
    const maxChunkSize = Math.floor(bufferSize / 2) // Use half of adaptive buffer

    // Try to split at JSON boundaries for better parsing
    if (data.includes('}{')) {
      // Split at JSON object boundaries
      const jsonObjects = data.split('}{')
      let currentChunk = ''

      for (let i = 0; i < jsonObjects.length; i++) {
        let obj = jsonObjects[i]

        // Add missing braces
        if (i > 0) obj = '{' + obj
        if (i < jsonObjects.length - 1) obj = obj + '}'

        if (currentChunk.length + obj.length > maxChunkSize && currentChunk.length > 0) {
          chunks.push(currentChunk)
          currentChunk = obj
        } else {
          currentChunk += obj
        }
      }

      if (currentChunk.length > 0) {
        chunks.push(currentChunk)
      }
    } else {
      // Fallback to simple splitting
      for (let i = 0; i < data.length; i += maxChunkSize) {
        chunks.push(data.slice(i, i + maxChunkSize))
      }
    }

    return chunks
  }

  /**
   * Check memory usage and perform cleanup if needed
   */
  private checkMemoryUsage(): void {
    const memUsage = process.memoryUsage()
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024)
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024)

    memoryLogger.usage(heapUsedMB, heapTotalMB)

    // If memory usage is high, trigger garbage collection if available
    if (heapUsedMB > 500 && global.gc) {
      memoryLogger.gc()
      global.gc()
    }
  }

  /**
   * PERFORMANCE OPTIMIZATION: Enhanced stuck stream sweeper with orphaned entry detection
   * Prevents memory leaks from abandoned streams and inconsistent state
   */
  private sweepStuckStreamsEnhanced(): void {
    const now = Date.now()
    const stuckStreams: string[] = []
    const orphanedEntries: string[] = []

    // Find streams that have been active too long
    for (const [streamId, startTime] of this.streamStartTimes.entries()) {
      if (now - startTime > this.STREAM_TIMEOUT_MS) {
        stuckStreams.push(streamId)
      }

      // Also check for orphaned entries (in streamStartTimes but not activeStreams)
      if (!this.activeStreams.has(streamId)) {
        orphanedEntries.push(streamId)
      }
    }

    // Find orphaned active streams (in activeStreams but not streamStartTimes)
    const orphanedActiveStreams: string[] = []
    for (const streamId of this.activeStreams) {
      if (!this.streamStartTimes.has(streamId)) {
        orphanedActiveStreams.push(streamId)
      }
    }

    // Cleanup all problematic streams
    const allProblematicStreams = [...stuckStreams, ...orphanedEntries, ...orphanedActiveStreams]

    if (allProblematicStreams.length > 0) {
      logger.warn('STREAM_CLEANUP',
        `🧹 Cleaning up ${stuckStreams.length} stuck, ${orphanedEntries.length} orphaned entries, ` +
        `${orphanedActiveStreams.length} orphaned active streams`
      )

      for (const streamId of allProblematicStreams) {
        // Use guaranteed cleanup for all problematic streams
        this.cleanupStreamGuaranteed(streamId, 'sweeper cleanup')

        // Update metrics to reflect the cleanup
        this.streamMetrics.failedStreams++
      }

      // Log cleanup summary for monitoring
      logger.info('STREAM_CLEANUP',
        `✅ Enhanced stream cleanup complete. Active streams: ${this.activeStreams.size}/${this.MAX_CONCURRENT_STREAMS}, ` +
        `Start times tracked: ${this.streamStartTimes.size}, Timeouts tracked: ${this.streamTimeouts.size}`
      )
    }
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use sweepStuckStreamsEnhanced instead
   */
  private sweepStuckStreams(): void {
    this.sweepStuckStreamsEnhanced()
  }

  /**
   * Get success rate percentage
   */
  private getSuccessRate(): number {
    if (this.streamMetrics.totalRequests === 0) return 100
    return Math.round((this.streamMetrics.successfulStreams / this.streamMetrics.totalRequests) * 100)
  }

  /**
   * Update stream completion metrics
   */
  private updateStreamMetrics(_streamId: string, success: boolean, duration: number): void {
    if (success) {
      this.streamMetrics.successfulStreams++
    } else {
      this.streamMetrics.failedStreams++
    }

    // Update average duration (rolling average)
    const totalCompleted = this.streamMetrics.successfulStreams + this.streamMetrics.failedStreams
    this.streamMetrics.averageStreamDuration =
      (this.streamMetrics.averageStreamDuration * (totalCompleted - 1) + duration) / totalCompleted
  }

  /**
   * PERFORMANCE OPTIMIZATION: Setup response cache and endpoint health checks
   * Initializes periodic cleanup for expired cache entries and endpoint health monitoring
   */
  private setupResponseCache(): void {
    // Start periodic cleanup every minute
    responseCache.startPeriodicCleanup(60000)

    // Start endpoint health checks every 5 minutes
    endpointCache.startPeriodicHealthChecks(300000)

    logger.info('RESPONSE_CACHE', '🗄️ Response cache initialized with periodic cleanup')
    logger.info('ENDPOINT_CACHE', '🏥 Endpoint health checks initialized')
  }

  /**
   * Format uptime in human-readable format
   */
  private formatUptime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`
    } else {
      return `${seconds}s`
    }
  }

  /**
   * Start the server with HTTP/1.1 and optional HTTP/2 support
   */
  async start(): Promise<void> {
    // Start HTTP/1.1 server on Node using @hono/node-server
    const server = serve({
      port: this.port,
      hostname: this.hostname,
      fetch: this.app.fetch,
    })

    logger.info('SERVER', `🚀 GitHub Copilot API Server running on http://${this.hostname}:${this.port}`)
    logger.info('SERVER', `📖 OpenAPI endpoint: http://${this.hostname}:${this.port}/v1/chat/completions`)
    logger.info('SERVER', `🔐 Auth status: http://${this.hostname}:${this.port}/auth/status`)
    logger.info('SERVER', `📋 Available models: http://${this.hostname}:${this.port}/v1/models`)
    logger.info('SERVER', `📊 Metrics endpoint: http://${this.hostname}:${this.port}/metrics`)
    logger.info('SERVER', `⚙️  Max concurrent streams: ${this.MAX_CONCURRENT_STREAMS}`)
    logger.info('SERVER', `🧠 Max buffer size: ${this.MAX_BUFFER_SIZE} bytes`)

    // Store server reference for graceful shutdown
    this.server = server

    // HTTP/1.1 only - clean and simple
    logger.info('SERVER', `🚀 Running HTTP/1.1 server with optimizations`)
    logger.info('SERVER', `📊 Streaming, compression, and caching enabled`)

    // Server ready
    logger.info('SERVER', `✅ HTTP/1.1 server ready and optimized`)
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log(`🛑 Initiating graceful shutdown...`)

    // Stop accepting new connections
    if (this.server) {
      this.server.stop()
    }

    // HTTP/1.1 server stopped

    // Wait for active streams to complete (with timeout)
    const shutdownTimeout = 30000 // 30 seconds
    const startTime = Date.now()

    while (this.activeStreams.size > 0 && (Date.now() - startTime) < shutdownTimeout) {
      console.log(`⏳ Waiting for ${this.activeStreams.size} active streams to complete...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    // Force close remaining streams
    if (this.activeStreams.size > 0) {
      console.log(`⚠️ Force closing ${this.activeStreams.size} remaining streams`)
      this.activeStreams.clear()
    }

    // Clean up monitoring intervals
    if (this.memoryMonitor) {
      clearInterval(this.memoryMonitor)
    }

    // Close connection pools
    await connectionPool.close()

    // Log final metrics
    logger.info('SERVER', `📊 Final metrics:`)
    logger.info('SERVER', `   Total requests: ${this.streamMetrics.totalRequests}`)
    logger.info('SERVER', `   Success rate: ${this.getSuccessRate()}%`)
    logger.info('SERVER', `   Total chunks: ${this.streamMetrics.totalChunks}`)
    logger.info('SERVER', `   Peak concurrent: ${this.streamMetrics.peakConcurrentStreams}`)

    logger.info('SERVER', `✅ Graceful shutdown completed`)
  }

  /**
   * Get the Hono app instance
   */
  getApp() {
    return this.app
  }
}
