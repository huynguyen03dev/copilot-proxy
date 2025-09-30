/**
 * Service Container
 * Manages service lifecycle and dependency injection for the application
 * 
 * PHASE 4: Centralized service management
 * - Provides singleton instances of all services
 * - Manages service initialization and dependencies
 * - Simplifies server constructor
 */

import { AuthService } from './authService.js'
import { PingDetectionService } from './pingDetectionService.js'
import { ResponseTransformService } from './responseTransformService.js'
import { EndpointDiscoveryService } from './endpointDiscoveryService.js'
import { StreamMonitorService } from './streamMonitorService.js'
import { MetricsService } from './metricsService.js'
import { ChatService, createChatService } from './chat/chatService.js'
import { StreamingService } from './streamingService.js'
import { connectionPool } from '../utils/connectionPool.js'
import { responseCache } from '../utils/responseCache.js'
import { endpointCache } from '../utils/endpointCache.js'
import { logger } from '../utils/logger.js'

/**
 * Server configuration for service initialization
 */
export interface ServerConfig {
  port: number
  hostname: string
  maxConcurrentStreams: number
  maxBufferSize: number
  memoryCheckInterval: number
  streamTimeoutMs: number
  isTestEnvironment: boolean
}

/**
 * Service Container
 * Provides centralized access to all services with proper dependency injection
 */
export class ServiceContainer {
  private services: Map<string, any> = new Map()
  private initialized: boolean = false
  private config: ServerConfig | null = null

  // Service instances
  private _authService: AuthService | null = null
  private _pingDetectionService: PingDetectionService | null = null
  private _responseTransformService: ResponseTransformService | null = null
  private _endpointDiscoveryService: EndpointDiscoveryService | null = null
  private _streamMonitorService: StreamMonitorService | null = null
  private _metricsService: MetricsService | null = null
  private _chatService: ChatService | null = null
  private _streamingService: StreamingService | null = null

  /**
   * Initialize all services with configuration
   */
  async initialize(config: ServerConfig): Promise<void> {
    if (this.initialized) {
      logger.warn('SERVICE_CONTAINER', 'Services already initialized')
      return
    }

    this.config = config
    logger.info('SERVICE_CONTAINER', '🔧 Initializing services...')

    try {
      // Initialize core services
      this._authService = new AuthService()
      this._pingDetectionService = new PingDetectionService()
      this._responseTransformService = new ResponseTransformService()
      this._endpointDiscoveryService = new EndpointDiscoveryService()
      
      // Initialize stream monitor service with config
      this._streamMonitorService = new StreamMonitorService(
        config.maxConcurrentStreams,
        config.streamTimeoutMs
      )
      
      // Initialize metrics service
      this._metricsService = new MetricsService()
      
      // Initialize streaming service
      this._streamingService = new StreamingService()
      
      // Initialize chat service with dependencies
      this._chatService = createChatService(
        this._endpointDiscoveryService,
        this._responseTransformService,
        this._streamMonitorService
      )

      // Store services in map for generic access
      this.services.set('auth', this._authService)
      this.services.set('pingDetection', this._pingDetectionService)
      this.services.set('responseTransform', this._responseTransformService)
      this.services.set('endpointDiscovery', this._endpointDiscoveryService)
      this.services.set('streamMonitor', this._streamMonitorService)
      this.services.set('metrics', this._metricsService)
      this.services.set('chat', this._chatService)
      this.services.set('streaming', this._streamingService)

      this.initialized = true
      logger.info('SERVICE_CONTAINER', `✅ ${this.services.size} services initialized successfully`)
      
    } catch (error) {
      logger.error('SERVICE_CONTAINER', `Failed to initialize services: ${error}`)
      throw error
    }
  }

  /**
   * Get AuthService instance
   */
  get authService(): AuthService {
    this.ensureInitialized()
    return this._authService!
  }

  /**
   * Get PingDetectionService instance
   */
  get pingDetectionService(): PingDetectionService {
    this.ensureInitialized()
    return this._pingDetectionService!
  }

  /**
   * Get ResponseTransformService instance
   */
  get responseTransformService(): ResponseTransformService {
    this.ensureInitialized()
    return this._responseTransformService!
  }

  /**
   * Get EndpointDiscoveryService instance
   */
  get endpointDiscoveryService(): EndpointDiscoveryService {
    this.ensureInitialized()
    return this._endpointDiscoveryService!
  }

  /**
   * Get StreamMonitorService instance
   */
  get streamMonitorService(): StreamMonitorService {
    this.ensureInitialized()
    return this._streamMonitorService!
  }

  /**
   * Get MetricsService instance
   */
  get metricsService(): MetricsService {
    this.ensureInitialized()
    return this._metricsService!
  }

  /**
   * Get ChatService instance
   */
  get chatService(): ChatService {
    this.ensureInitialized()
    return this._chatService!
  }

  /**
   * Get StreamingService instance
   */
  get streamingService(): StreamingService {
    this.ensureInitialized()
    return this._streamingService!
  }

  /**
   * Get all services as an object (for route setup)
   */
  getAllServices(): {
    auth: AuthService
    pingDetection: PingDetectionService
    responseTransform: ResponseTransformService
    endpointDiscovery: EndpointDiscoveryService
    streamMonitor: StreamMonitorService
    metrics: MetricsService
    chat: ChatService
    streaming: StreamingService
  } {
    this.ensureInitialized()
    return {
      auth: this._authService!,
      pingDetection: this._pingDetectionService!,
      responseTransform: this._responseTransformService!,
      endpointDiscovery: this._endpointDiscoveryService!,
      streamMonitor: this._streamMonitorService!,
      metrics: this._metricsService!,
      chat: this._chatService!,
      streaming: this._streamingService!
    }
  }

  /**
   * Get a service by name (generic accessor)
   */
  get<T>(serviceName: string): T {
    this.ensureInitialized()
    const service = this.services.get(serviceName)
    if (!service) {
      throw new Error(`Service '${serviceName}' not found in container`)
    }
    return service as T
  }

  /**
   * Check if services are initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Dispose all services and cleanup resources
   */
  async dispose(): Promise<void> {
    if (!this.initialized) {
      return
    }

    logger.info('SERVICE_CONTAINER', '🧹 Disposing services...')

    try {
      // Cleanup stream monitor service
      if (this._streamMonitorService) {
        await this._streamMonitorService.dispose()
      }

      // Cleanup metrics service intervals
      if (this._metricsService) {
        // Add dispose method if needed
      }

      // Clear service references
      this._authService = null
      this._pingDetectionService = null
      this._responseTransformService = null
      this._endpointDiscoveryService = null
      this._streamMonitorService = null
      this._metricsService = null
      this._chatService = null
      this._streamingService = null

      this.services.clear()
      this.initialized = false

      logger.info('SERVICE_CONTAINER', '✅ Services disposed successfully')
      
    } catch (error) {
      logger.error('SERVICE_CONTAINER', `Error disposing services: ${error}`)
      throw error
    }
  }

  /**
   * Ensure services are initialized before access
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.')
    }
  }
}

/**
 * Singleton instance for global access
 */
export const serviceContainer = new ServiceContainer()
