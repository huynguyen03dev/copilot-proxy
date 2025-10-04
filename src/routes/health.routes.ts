import { Hono } from "hono"
import { connectionPool } from "../utils/connectionPool.js"
import { streamingManager } from "../utils/streamingManager.js"
import { responseCache } from "../utils/responseCache.js"

/**
 * Health and metrics route handlers
 * Provides health check, server metrics, and connection pool monitoring endpoints
 */

export interface ServerMetrics {
  startTime: number
  totalRequests: number
  successfulStreams: number
  failedStreams: number
  totalChunks: number
  totalBytes: number
  averageStreamDuration: number
  peakConcurrentStreams: number
}

export interface ServerInfo {
  activeStreams: Set<string>
  maxConcurrentStreams: number
  metrics: ServerMetrics
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(milliseconds: number): string {
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
 * Calculate success rate percentage
 */
function getSuccessRate(metrics: ServerMetrics): number {
  if (metrics.totalRequests === 0) return 100
  return Math.round((metrics.successfulStreams / metrics.totalRequests) * 100)
}

/**
 * Create health and metrics routes
 */
export function createHealthRoutes(serverInfo: ServerInfo): Hono {
  const app = new Hono()

  /**
   * GET / - Health check endpoint
   * Returns basic server health status
   */
  app.get("/", (c) => {
    return c.json({
      status: "healthy",
      service: "GitHub Copilot API Server",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - serverInfo.metrics.startTime) / 1000),
      activeStreams: serverInfo.activeStreams.size,
      maxStreams: serverInfo.maxConcurrentStreams
    })
  })

  /**
   * GET /metrics - Server metrics endpoint
   * Returns detailed metrics for monitoring
   */
  app.get("/metrics", (c) => {
    const uptime = Date.now() - serverInfo.metrics.startTime
    const uptimeHours = Math.round(uptime / (1000 * 60 * 60) * 100) / 100

    return c.json({
      uptime: {
        milliseconds: uptime,
        hours: uptimeHours,
        human: formatUptime(uptime)
      },
      streams: {
        active: serverInfo.activeStreams.size,
        maxConcurrent: serverInfo.maxConcurrentStreams,
        peakConcurrent: serverInfo.metrics.peakConcurrentStreams,
        total: serverInfo.metrics.totalRequests,
        successful: serverInfo.metrics.successfulStreams,
        failed: serverInfo.metrics.failedStreams,
        successRate: getSuccessRate(serverInfo.metrics)
      },
      performance: {
        totalChunks: serverInfo.metrics.totalChunks,
        totalBytes: serverInfo.metrics.totalBytes,
        averageStreamDuration: Math.round(serverInfo.metrics.averageStreamDuration),
        chunksPerSecond: Math.round(serverInfo.metrics.totalChunks / (uptime / 1000)),
        bytesPerSecond: Math.round(serverInfo.metrics.totalBytes / (uptime / 1000))
      },
      memory: process.memoryUsage(),
      connectionPool: connectionPool.getOverallStats(),
      streamingManager: streamingManager.getStreamingStats(),
      timestamp: new Date().toISOString()
    })
  })

  /**
   * GET /pool/metrics - Connection pool metrics endpoint
   * Returns detailed connection pool statistics for performance monitoring
   */
  app.get("/pool/metrics", (c) => {
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

  return app
}
