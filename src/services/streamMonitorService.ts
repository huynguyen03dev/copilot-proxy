import { logger, streamLogger } from '../utils/logger.js'
import { TIMEOUT_CONSTANTS } from '../constants/index.js'

/**
 * Stream lifecycle events
 */
export type StreamLifecycleEvent = 
  | 'started'
  | 'completed'
  | 'aborted'
  | 'timeout'
  | 'error'

/**
 * Stream metrics
 */
export interface StreamMetrics {
  totalRequests: number
  successfulStreams: number
  failedStreams: number
  totalChunks: number
  totalBytes: number
  averageStreamDuration: number
  peakConcurrentStreams: number
  startTime: number
}

/**
 * Service for monitoring and managing streaming connections
 * 
 * Features:
 * - Track active streams
 * - Monitor stream lifecycle
 * - Automatic cleanup and timeout handling
 * - Stream metrics tracking
 * - Stuck stream detection and cleanup
 */
export class StreamMonitorService {
  private activeStreams = new Set<string>()
  private streamStartTimes = new Map<string, number>()
  private streamTimeouts = new Map<string, NodeJS.Timeout>()
  private readonly maxConcurrentStreams: number
  private readonly streamTimeoutMs: number
  
  private streamMetrics: StreamMetrics = {
    totalRequests: 0,
    successfulStreams: 0,
    failedStreams: 0,
    totalChunks: 0,
    totalBytes: 0,
    averageStreamDuration: 0,
    peakConcurrentStreams: 0,
    startTime: Date.now()
  }
  
  constructor(maxConcurrentStreams: number = 100, streamTimeoutMs: number = TIMEOUT_CONSTANTS.STREAM_TIMEOUT_MS) {
    this.maxConcurrentStreams = maxConcurrentStreams
    this.streamTimeoutMs = streamTimeoutMs
  }
  
  /**
   * Track an active streaming connection
   */
  trackStream(streamId: string): void {
    this.activeStreams.add(streamId)
    this.streamStartTimes.set(streamId, Date.now())
    this.streamMetrics.totalRequests++
    
    // Set up automatic cleanup timeout as safety net
    const timeoutId = setTimeout(() => {
      logger.warn('STREAM_TIMEOUT', `Stream ${streamId} timed out after ${this.streamTimeoutMs}ms`)
      this.cleanupStream(streamId, 'timeout')
    }, this.streamTimeoutMs)
    
    this.streamTimeouts.set(streamId, timeoutId)
    
    // Update peak concurrent streams
    if (this.activeStreams.size > this.streamMetrics.peakConcurrentStreams) {
      this.streamMetrics.peakConcurrentStreams = this.activeStreams.size
    }
    
    streamLogger.start(streamId, this.activeStreams.size, this.maxConcurrentStreams)
  }
  
  /**
   * Untrack a streaming connection
   */
  untrackStream(streamId: string): void {
    this.cleanupStream(streamId, 'normal completion')
  }
  
  /**
   * Guaranteed stream cleanup with comprehensive error handling
   */
  async cleanupStream(streamId: string, reason: string): Promise<void> {
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
      streamLogger.end(streamId, this.activeStreams.size, this.maxConcurrentStreams)
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
   * Update stream completion metrics
   */
  updateStreamMetrics(streamId: string, success: boolean, duration: number): void {
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
   * Update chunk and byte metrics
   */
  updateChunkMetrics(chunkCount: number, byteCount: number): void {
    this.streamMetrics.totalChunks += chunkCount
    this.streamMetrics.totalBytes += byteCount
  }
  
  /**
   * Sweep stuck streams to prevent memory leaks
   * 
   * Removes streams that have been active longer than the timeout threshold
   * and detects orphaned entries in tracking maps
   */
  sweepStuckStreams(): void {
    const now = Date.now()
    const stuckStreams: string[] = []
    const orphanedEntries: string[] = []
    
    // Find streams that have been active too long
    for (const [streamId, startTime] of this.streamStartTimes.entries()) {
      if (now - startTime > this.streamTimeoutMs) {
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
        void this.cleanupStream(streamId, 'sweeper cleanup')
        
        // Update metrics to reflect the cleanup
        this.streamMetrics.failedStreams++
      }
      
      // Log cleanup summary for monitoring
      logger.info('STREAM_CLEANUP',
        `✅ Stream cleanup complete. Active streams: ${this.activeStreams.size}/${this.maxConcurrentStreams}, ` +
        `Start times tracked: ${this.streamStartTimes.size}, Timeouts tracked: ${this.streamTimeouts.size}`
      )
    }
  }
  
  /**
   * Get current stream metrics
   */
  getMetrics(): StreamMetrics {
    return { ...this.streamMetrics }
  }
  
  /**
   * Get active stream count
   */
  getActiveStreamCount(): number {
    return this.activeStreams.size
  }
  
  /**
   * Get max concurrent streams
   */
  getMaxConcurrentStreams(): number {
    return this.maxConcurrentStreams
  }
  
  /**
   * Check if stream is active
   */
  isStreamActive(streamId: string): boolean {
    return this.activeStreams.has(streamId)
  }
  
  /**
   * Get stream duration
   */
  getStreamDuration(streamId: string): number | null {
    const startTime = this.streamStartTimes.get(streamId)
    if (!startTime) return null
    return Date.now() - startTime
  }
  
  /**
   * Get success rate percentage
   */
  getSuccessRate(): number {
    if (this.streamMetrics.totalRequests === 0) return 100
    return Math.round((this.streamMetrics.successfulStreams / this.streamMetrics.totalRequests) * 100)
  }
  
  /**
   * Get active stream IDs
   */
  getActiveStreamIds(): string[] {
    return Array.from(this.activeStreams)
  }
  
  /**
   * Dispose service and cleanup resources
   */
  async dispose(): Promise<void> {
    logger.info('STREAM_MONITOR', '🧹 Disposing stream monitor service...')
    
    // Clear all active streams
    for (const streamId of this.activeStreams) {
      await this.cleanupStream(streamId, 'service disposal')
    }
    
    // Clear all tracking data
    this.activeStreams.clear()
    this.streamStartTimes.clear()
    this.streamTimeouts.clear()
    
    logger.info('STREAM_MONITOR', '✅ Stream monitor service disposed')
  }
}

/**
 * Singleton instance for convenience
 */
export const streamMonitorService = new StreamMonitorService()
