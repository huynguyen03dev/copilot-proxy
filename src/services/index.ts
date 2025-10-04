/**
 * Services Index
 * Central export point for all service modules
 */

// Service Container (Phase 4)
export { ServiceContainer, serviceContainer } from './serviceContainer.js'
export type { ServerConfig } from './serviceContainer.js'

// Core services
export { PingDetectionService, pingDetectionService } from './pingDetectionService.js'
export type { PingDetectionConfig, PingDetectionResult } from './pingDetectionService.js'

export { ResponseTransformService, responseTransformService } from './responseTransformService.js'

export { EndpointDiscoveryService, endpointDiscoveryService } from './endpointDiscoveryService.js'
export type { EndpointDiscoveryResult } from './endpointDiscoveryService.js'

export { StreamMonitorService, streamMonitorService } from './streamMonitorService.js'
export type { StreamLifecycleEvent, StreamMetrics } from './streamMonitorService.js'

export { MetricsService, metricsService } from './metricsService.js'
export type {
  ServerMetrics,
  MemoryMetrics,
  PoolMetrics,
  StreamingManagerMetrics
} from './metricsService.js'

export { ChatService, createChatService } from './chat/chatService.js'

// Existing services (re-exported for convenience)
export { AuthService } from './authService.js'
export type { AuthResult, AuthFlowData, AuthStatus } from './authService.js'

export { StreamingService, streamingService } from './streamingService.js'
export type { StreamingOptions } from './streamingService.js'

export { ConsolidatedValidationService } from './consolidatedValidationService.js'
export type { ValidationResult } from './consolidatedValidationService.js'

export { RequestValidationService } from './requestValidationService.js'
