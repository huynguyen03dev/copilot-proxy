import { Hono } from "hono"
import { serve } from "@hono/node-server"

import { cors } from "hono/cors"
import { logger as honoLogger } from "hono/logger"
import { streamSSE } from "hono/streaming"
import { zValidator } from "@hono/zod-validator"
import { GitHubCopilotAuth } from "./auth.js"
import { setupRoutes } from "./routes/index.js"
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
import { zodValidationMiddleware } from "./middleware/zodValidation.js"
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
import { streamingService } from "./services/streamingService.js"
import { ServiceContainer, type ServerConfig } from "./services/index.js"

export class CopilotAPIServer {
  private app: Hono
  private port: number
  private hostname: string

  // Service container for dependency injection
  private services: ServiceContainer

  // Connection management constants
  private readonly MAX_CONCURRENT_STREAMS = config.server.maxConcurrentStreams
  private readonly IS_TEST_ENVIRONMENT = process.env.NODE_ENV === 'test'
  private readonly STREAM_TIMEOUT_MS = TIMEOUT_CONSTANTS.STREAM_TIMEOUT_MS
  private readonly MAX_BUFFER_SIZE = config.streaming.maxBufferSize
  private readonly MEMORY_CHECK_INTERVAL = config.monitoring.memoryCheckInterval

  // Memory management
  private memoryMonitor: NodeJS.Timeout | null = null

  // Server instance for graceful shutdown
  private server: any = null

  constructor(
    port: number = config.server.port,
    hostname: string = config.server.hostname
  ) {
    this.port = port
    this.hostname = hostname
    this.app = new Hono()

    // Initialize service container (async init in start())
    this.services = new ServiceContainer()

    // Log configuration on startup
    logConfiguration()

    // Initialize advanced logging system
    this.initializeAdvancedLogging()

    this.setupMiddleware()
    // Routes setup moved to initializeServices() after services are ready
    this.setupConnectionMonitoring()
    this.setupResponseCache()
  }

  /**
   * Initialize services and routes
   * Must be called before start()
   */
  async initializeServices(): Promise<void> {
    // Initialize service container with configuration
    await this.services.initialize({
      port: this.port,
      hostname: this.hostname,
      maxConcurrentStreams: this.MAX_CONCURRENT_STREAMS,
      maxBufferSize: this.MAX_BUFFER_SIZE,
      memoryCheckInterval: this.MEMORY_CHECK_INTERVAL,
      streamTimeoutMs: this.STREAM_TIMEOUT_MS,
      isTestEnvironment: this.IS_TEST_ENVIRONMENT
    })

    logger.info('SERVER', '✅ Services initialized successfully')
    
    // Setup routes after services are initialized
    this.setupRoutes()
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
    // PERFORMANCE: Helper to skip expensive middleware for health check routes
    const skipForHealthChecks = (middleware: any) => {
      return async (c: any, next: any) => {
        // Skip expensive middleware for health check endpoints
        if (c.req.path === '/' || c.req.path === '/health' || c.req.path === '/metrics') {
          return next()
        }
        return middleware(c, next)
      }
    }

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

    // PERFORMANCE: Skip compression for health checks
    // Response compression middleware (early in pipeline for optimal performance)
    if (config.performance.enableCompression) {
      this.app.use("*", skipForHealthChecks(compressionMiddleware(
        this.IS_TEST_ENVIRONMENT ? DEFAULT_COMPRESSION_CONFIG : PRODUCTION_COMPRESSION_CONFIG
      )))
      logger.info('SERVER', '🗜️  Response compression enabled (skipped for health checks)')
    }

    // Streaming validation temporarily disabled to avoid full-body buffering
    // this.app.use("*", streamingValidationMiddleware(
    //   this.IS_TEST_ENVIRONMENT ? TEST_STREAMING_CONFIG : PRODUCTION_STREAMING_CONFIG
    // ))

    // PERFORMANCE: Skip request size validation for health checks
    // Request size validation middleware (after streaming validation, before route handlers)
    this.app.use("*", skipForHealthChecks(requestSizeMiddleware(
      this.IS_TEST_ENVIRONMENT ? TEST_LIMITS : PRODUCTION_LIMITS
    )))

    // PERFORMANCE OPTIMIZATION (Phase 5, Issue #9): Zod validation middleware
    // Validates request body once in middleware instead of in route handlers
    this.app.use("*", skipForHealthChecks(zodValidationMiddleware()))
    logger.info('SERVER', '✅ Zod validation middleware enabled (skipped for health checks)')

    // PERFORMANCE: Skip cache headers for health checks
    // Cache headers middleware (for optimal client-side caching)
    this.app.use("*", skipForHealthChecks(cacheHeadersMiddleware(
      this.IS_TEST_ENVIRONMENT ? TEST_CACHE_CONFIG : PRODUCTION_CACHE_CONFIG
    )))
    logger.info('SERVER', '📦 Cache headers enabled (skipped for health checks)')

    // PERFORMANCE: Skip circuit breaker for health checks
    // Circuit breaker middleware (for fault tolerance)
    this.app.use("*", skipForHealthChecks(circuitBreakerMiddleware(
      this.IS_TEST_ENVIRONMENT ? DEFAULT_CIRCUIT_BREAKER_MIDDLEWARE_CONFIG : PRODUCTION_CIRCUIT_BREAKER_MIDDLEWARE_CONFIG
    )))

    // Circuit breaker health and admin endpoints
    this.app.use("*", circuitBreakerHealthMiddleware())
    this.app.use("*", circuitBreakerAdminMiddleware())
    logger.info('SERVER', '🔄 Circuit breaker middleware enabled (skipped for health checks)')

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
    // Setup all routes using the extracted route modules and services
    const services = this.services.getAllServices()
    const streamMonitor = this.services.streamMonitorService
    const metrics = streamMonitor.getMetrics()
    
    setupRoutes(this.app, {
      serverInfo: {
        activeStreams: new Set<string>(), // Deprecated - use services
        maxConcurrentStreams: this.MAX_CONCURRENT_STREAMS,
        metrics: metrics as any // Use service metrics
      },
      chatDeps: {
        chatService: services.chat,
        streamMonitor: streamMonitor,
        maxConcurrentStreams: this.MAX_CONCURRENT_STREAMS,
        isTestEnvironment: this.IS_TEST_ENVIRONMENT
      }
    })
  }

  // Business logic now delegated to ChatService
  // All endpoint discovery, request forwarding, and response transformation
  // is handled by the service layer (see src/services/chat/chatService.ts)


  /**
   * Set up connection monitoring
   */
  private setupConnectionMonitoring(): void {
    // Monitor active streams every minute
    setInterval(() => {
      if (this.services.isInitialized()) {
        const streamMonitor = this.services.streamMonitorService
        const currentActive = streamMonitor.getActiveStreamCount()
        const metrics = streamMonitor.getMetrics()

        logger.info('MONITOR', `📊 Active streams: ${currentActive}/${this.MAX_CONCURRENT_STREAMS}`)
        logger.info('MONITOR', `📈 Peak concurrent: ${metrics.peakConcurrentStreams}`)
        logger.info('MONITOR', `📊 Total requests: ${metrics.totalRequests}`)
        logger.info('MONITOR', `✅ Success rate: ${streamMonitor.getSuccessRate()}%`)

        // Sweep stuck streams
        streamMonitor.sweepStuckStreams()
      }
    }, 60000) // Every minute

    // Set up memory monitoring
    this.memoryMonitor = setInterval(() => {
      this.checkMemoryUsage()
    }, this.MEMORY_CHECK_INTERVAL)
  }

  // Connection warmup now handled by ChatService



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
   * Start the server with HTTP/1.1 and optional HTTP/2 support
   */
  async start(): Promise<void> {
    // Initialize services first
    if (!this.services.isInitialized()) {
      await this.initializeServices()
    }

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
    logger.info('SERVER', '🛑 Initiating graceful shutdown...')

    // Stop accepting new connections
    if (this.server) {
      this.server.stop()
    }

    // HTTP/1.1 server stopped

    // Wait for active streams to complete (with timeout)
    const shutdownTimeout = 30000 // 30 seconds
    const startTime = Date.now()

    // Wait for active streams using service container
    if (this.services.isInitialized()) {
      const streamMonitor = this.services.streamMonitorService
      
      while (streamMonitor.getActiveStreamCount() > 0 && (Date.now() - startTime) < shutdownTimeout) {
        logger.info('SERVER', `⏳ Waiting for ${streamMonitor.getActiveStreamCount()} active streams to complete...`)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      // Force close remaining streams
      if (streamMonitor.getActiveStreamCount() > 0) {
        logger.warn('SERVER', `⚠️ Force closing ${streamMonitor.getActiveStreamCount()} remaining streams`)
      }

      // Dispose all services
      await this.services.dispose()
    }

    // Clean up monitoring intervals
    if (this.memoryMonitor) {
      clearInterval(this.memoryMonitor)
    }

    // Close connection pools
    await connectionPool.close()

    // Log final metrics
    if (this.services.isInitialized()) {
      const metrics = this.services.streamMonitorService.getMetrics()
      const successRate = this.services.streamMonitorService.getSuccessRate()
      logger.info('SERVER', `📊 Final metrics:`)
      logger.info('SERVER', `   Total requests: ${metrics.totalRequests}`)
      logger.info('SERVER', `   Success rate: ${successRate}%`)
      logger.info('SERVER', `   Total chunks: ${metrics.totalChunks}`)
      logger.info('SERVER', `   Peak concurrent: ${metrics.peakConcurrentStreams}`)
    }

    logger.info('SERVER', `✅ Graceful shutdown completed`)
  }

  /**
   * Get the Hono app instance
   */
  getApp() {
    return this.app
  }
}
