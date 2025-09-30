import { connectionPool } from '../utils/connectionPool.js'
import { streamingManager } from '../utils/streamingManager.js'
import type { StreamMetrics } from './streamMonitorService.js'

/**
 * Server metrics
 */
export interface ServerMetrics {
  uptime: number
  uptimeFormatted: string
  totalRequests: number
  successfulStreams: number
  failedStreams: number
  successRate: number
  activeStreams: number
  peakConcurrentStreams: number
  maxConcurrentStreams: number
  totalChunks: number
  totalBytes: number
  averageStreamDuration: number
  memory: MemoryMetrics
  connectionPool: PoolMetrics
  streamingManager: StreamingManagerMetrics
}

/**
 * Memory usage metrics
 */
export interface MemoryMetrics {
  heapUsed: number
  heapUsedMB: number
  heapTotal: number
  heapTotalMB: number
  external: number
  rss: number
  rssMB: number
}

/**
 * Connection pool metrics
 */
export interface PoolMetrics {
  activeConnections: number
  pendingRequests: number
  totalRequests: number
  totalErrors: number
  averageResponseTime: number
  queuedRequests: number
  averageQueueTime: number
  connectionUtilization: number
}

/**
 * Streaming manager metrics
 */
export interface StreamingManagerMetrics {
  activeStreams: number
  totalBufferSize: number
  controllerStates: number
}

/**
 * Service for collecting and formatting server metrics
 * 
 * Features:
 * - Server uptime tracking
 * - Stream metrics aggregation
 * - Memory usage monitoring
 * - Connection pool statistics
 * - Streaming manager statistics
 * - Human-readable formatting
 */
export class MetricsService {
  private startTime: number
  
  constructor() {
    this.startTime = Date.now()
  }
  
  /**
   * Get comprehensive server metrics
   */
  getServerMetrics(
    streamMetrics: StreamMetrics,
    activeStreams: number,
    maxConcurrentStreams: number
  ): ServerMetrics {
    const uptime = Date.now() - this.startTime
    const successRate = this.calculateSuccessRate(streamMetrics.successfulStreams, streamMetrics.totalRequests)
    
    return {
      uptime,
      uptimeFormatted: this.formatUptime(uptime),
      totalRequests: streamMetrics.totalRequests,
      successfulStreams: streamMetrics.successfulStreams,
      failedStreams: streamMetrics.failedStreams,
      successRate,
      activeStreams,
      peakConcurrentStreams: streamMetrics.peakConcurrentStreams,
      maxConcurrentStreams,
      totalChunks: streamMetrics.totalChunks,
      totalBytes: streamMetrics.totalBytes,
      averageStreamDuration: streamMetrics.averageStreamDuration,
      memory: this.getMemoryMetrics(),
      connectionPool: this.getConnectionPoolMetrics(),
      streamingManager: this.getStreamingManagerMetrics()
    }
  }
  
  /**
   * Get memory usage metrics
   */
  getMemoryMetrics(): MemoryMetrics {
    const memUsage = process.memoryUsage()
    
    return {
      heapUsed: memUsage.heapUsed,
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: memUsage.heapTotal,
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: memUsage.external,
      rss: memUsage.rss,
      rssMB: Math.round(memUsage.rss / 1024 / 1024)
    }
  }
  
  /**
   * Get connection pool metrics
   */
  getConnectionPoolMetrics(): PoolMetrics {
    const stats = connectionPool.getStats()
    
    // If stats is a Map, aggregate all origins
    if (stats instanceof Map) {
      let aggregated = {
        activeConnections: 0,
        pendingRequests: 0,
        totalRequests: 0,
        totalErrors: 0,
        averageResponseTime: 0,
        queuedRequests: 0,
        averageQueueTime: 0,
        connectionUtilization: 0
      }
      
      let count = 0
      for (const [, poolStats] of stats) {
        aggregated.activeConnections += poolStats.activeConnections
        aggregated.pendingRequests += poolStats.pendingRequests
        aggregated.totalRequests += poolStats.totalRequests
        aggregated.totalErrors += poolStats.totalErrors
        aggregated.averageResponseTime += poolStats.averageResponseTime
        aggregated.queuedRequests += poolStats.queuedRequests
        aggregated.averageQueueTime += poolStats.averageQueueTime
        aggregated.connectionUtilization += poolStats.connectionUtilization
        count++
      }
      
      // Average the averages
      if (count > 0) {
        aggregated.averageResponseTime /= count
        aggregated.averageQueueTime /= count
        aggregated.connectionUtilization /= count
      }
      
      return aggregated
    }
    
    // Single stats object
    return {
      activeConnections: stats.activeConnections,
      pendingRequests: stats.pendingRequests,
      totalRequests: stats.totalRequests,
      totalErrors: stats.totalErrors,
      averageResponseTime: stats.averageResponseTime,
      queuedRequests: stats.queuedRequests,
      averageQueueTime: stats.averageQueueTime,
      connectionUtilization: stats.connectionUtilization
    }
  }
  
  /**
   * Get streaming manager metrics
   */
  getStreamingManagerMetrics(): StreamingManagerMetrics {
    const stats = streamingManager.getStats()
    
    return {
      activeStreams: stats.activeStreams,
      totalBufferSize: stats.totalBufferSize,
      controllerStates: stats.controllerStates
    }
  }
  
  /**
   * Calculate success rate percentage
   */
  calculateSuccessRate(successfulRequests: number, totalRequests: number): number {
    if (totalRequests === 0) return 100
    return Math.round((successfulRequests / totalRequests) * 100)
  }
  
  /**
   * Format uptime in human-readable format
   */
  formatUptime(milliseconds: number): string {
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
   * Format bytes to human-readable format
   */
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    
    return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`
  }
  
  /**
   * Format duration in milliseconds to human-readable format
   */
  formatDuration(milliseconds: number): string {
    if (milliseconds < 1000) {
      return `${Math.round(milliseconds)}ms`
    } else if (milliseconds < 60000) {
      return `${Math.round(milliseconds / 1000 * 10) / 10}s`
    } else if (milliseconds < 3600000) {
      return `${Math.round(milliseconds / 60000)}m`
    } else {
      return `${Math.round(milliseconds / 3600000 * 10) / 10}h`
    }
  }
  
  /**
   * Reset start time (for testing or server restart)
   */
  resetStartTime(): void {
    this.startTime = Date.now()
  }
  
  /**
   * Get current uptime in milliseconds
   */
  getUptime(): number {
    return Date.now() - this.startTime
  }
  
  /**
   * Get formatted uptime
   */
  getFormattedUptime(): string {
    return this.formatUptime(this.getUptime())
  }
}

/**
 * Singleton instance for convenience
 */
export const metricsService = new MetricsService()
