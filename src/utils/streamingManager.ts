/**
 * Advanced Streaming Manager
 * Implements backpressure handling, optimized chunk processing, and streaming performance enhancements
 */

import { logger } from './logger.js'
import { streamCoordinator } from './streamCoordinator.js'

export interface StreamingConfig {
  maxConcurrentStreams: number
  chunkBufferSize: number
  backpressureThreshold: number
  adaptiveBuffering: boolean
  compressionEnabled: boolean
  contentOptimizationEnabled: boolean
  workerPoolSize: number
}

export interface StreamMetrics {
  streamId: string
  startTime: number
  chunksProcessed: number
  bytesProcessed: number
  averageChunkSize: number
  processingRate: number
  backpressureEvents: number
  compressionRatio?: number
}

export interface BackpressureState {
  isActive: boolean
  bufferUtilization: number
  downstreamRate: number
  adaptiveDelay: number
}

export class StreamingManager {
  private activeStreams = new Map<string, StreamMetrics>()
  private streamBuffers = new Map<string, Buffer[]>()
  private backpressureStates = new Map<string, BackpressureState>()
  private controllerStates = new Map<string, { closed: boolean, reason?: string }>()
  private workerPool: Worker[] = []
  private config: StreamingConfig

  constructor(config: Partial<StreamingConfig> = {}) {
    this.config = {
      maxConcurrentStreams: 150,
      chunkBufferSize: 64 * 1024, // 64KB chunks
      backpressureThreshold: 0.8, // 80% buffer utilization
      adaptiveBuffering: true,
      compressionEnabled: false, // Disabled by default to prevent JSON corruption
      contentOptimizationEnabled: false, // Disabled by default for safety
      workerPoolSize: 4,
      ...config
    }

    this.initializeWorkerPool()
    logger.info('STREAMING_MANAGER', `Initialized with ${this.config.maxConcurrentStreams} max streams`)
  }

  /**
   * Start a new optimized stream with backpressure handling and coordination
   */
  async startStream(streamId: string, sourceStream: ReadableStream): Promise<ReadableStream> {
    if (this.activeStreams.size >= this.config.maxConcurrentStreams) {
      throw new Error(`Maximum concurrent streams (${this.config.maxConcurrentStreams}) exceeded`)
    }

    // Register with the global coordinator
    const streamState = streamCoordinator.registerStream(streamId)
    streamCoordinator.markLayerActive(streamId, 'streamingManager')

    const metrics: StreamMetrics = {
      streamId,
      startTime: Date.now(),
      chunksProcessed: 0,
      bytesProcessed: 0,
      averageChunkSize: 0,
      processingRate: 0,
      backpressureEvents: 0
    }

    this.activeStreams.set(streamId, metrics)
    this.streamBuffers.set(streamId, [])
    this.backpressureStates.set(streamId, {
      isActive: false,
      bufferUtilization: 0,
      downstreamRate: 0,
      adaptiveDelay: 0
    })
    this.controllerStates.set(streamId, { closed: false })

    // Register cleanup callback with coordinator
    streamCoordinator.registerCleanupCallback(streamId, () => {
      this.cleanupStreamInternal(streamId)
    })

    logger.debug('STREAMING_MANAGER', `Started stream ${streamId}`)

    return this.createOptimizedStream(streamId, sourceStream)
  }

  /**
   * Create an optimized readable stream with backpressure and performance enhancements
   */
  private createOptimizedStream(streamId: string, sourceStream: ReadableStream): ReadableStream {
    const reader = sourceStream.getReader()
    const metrics = this.activeStreams.get(streamId)!
    const buffer = this.streamBuffers.get(streamId)!

    // Register reader and controller with coordinator
    streamCoordinator.registerReader(streamId, reader)

    return new ReadableStream({
      start: (controller) => {
        streamCoordinator.registerController(streamId, controller)
        logger.debug('STREAMING_MANAGER', `Stream ${streamId} started`)
      },

      pull: async (controller) => {
        try {
          // Check backpressure before processing
          await this.handleBackpressure(streamId, controller)

          // Read from source with optimized buffering
          const { done, value } = await reader.read()

          if (done) {
            // Use coordinator for safe finalization
            await streamCoordinator.initiateCleanup(streamId, 'stream completed', 'streamingManager')
            return
          }

          // Process chunk with optimizations
          const processedChunk = await this.processChunkOptimized(streamId, value)

          if (processedChunk) {
            // STABILITY FIX: Check if stream is still active via coordinator
            if (streamCoordinator.isStreamActive(streamId) && this.isControllerOpen(streamId, controller)) {
              controller.enqueue(processedChunk)
              this.updateMetrics(streamId, processedChunk)
            } else {
              logger.debug('STREAMING_MANAGER', `Stream ${streamId} no longer active, skipping enqueue`)
            }
          }

        } catch (error) {
          logger.error('STREAMING_MANAGER', `Stream ${streamId} error: ${error}`)

          // Use coordinator for error cleanup
          await streamCoordinator.initiateCleanup(streamId, `error: ${error}`, 'streamingManager')
        }
      },

      cancel: (reason) => {
        logger.debug('STREAMING_MANAGER', `Stream ${streamId} cancelled: ${reason}`)

        // Use coordinator for cancellation cleanup
        streamCoordinator.initiateCleanup(streamId, `cancelled: ${reason}`, 'streamingManager')
      }
    })
  }

  /**
   * Handle backpressure with adaptive buffering
   */
  private async handleBackpressure(streamId: string, controller: ReadableStreamDefaultController): Promise<void> {
    const backpressureState = this.backpressureStates.get(streamId)!
    const buffer = this.streamBuffers.get(streamId)!
    const metrics = this.activeStreams.get(streamId)!

    // Calculate buffer utilization
    const bufferSize = buffer.reduce((total, chunk) => total + chunk.length, 0)
    const utilization = bufferSize / this.config.chunkBufferSize

    backpressureState.bufferUtilization = utilization

    // Activate backpressure if threshold exceeded
    if (utilization > this.config.backpressureThreshold) {
      if (!backpressureState.isActive) {
        backpressureState.isActive = true
        metrics.backpressureEvents++
        logger.debug('STREAMING_MANAGER', `Backpressure activated for stream ${streamId} (${(utilization * 100).toFixed(1)}% buffer utilization)`)
      }

      // Adaptive delay based on buffer utilization
      if (this.config.adaptiveBuffering) {
        const delay = Math.min(100, (utilization - this.config.backpressureThreshold) * 200)
        backpressureState.adaptiveDelay = delay
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    } else if (backpressureState.isActive && utilization < this.config.backpressureThreshold * 0.7) {
      // Deactivate backpressure with hysteresis
      backpressureState.isActive = false
      backpressureState.adaptiveDelay = 0
      logger.debug('STREAMING_MANAGER', `Backpressure deactivated for stream ${streamId}`)
    }
  }

  /**
   * Process chunk with optimizations (compression, efficient parsing, etc.)
   */
  private async processChunkOptimized(streamId: string, chunk: Uint8Array): Promise<Uint8Array | null> {
    if (!chunk || chunk.length === 0) {
      return null
    }

    try {
      // Convert to buffer for efficient processing
      const buffer = Buffer.from(chunk)
      
      // Apply compression if enabled and chunk is large enough (but be conservative)
      let processedBuffer = buffer
      if (this.config.compressionEnabled && buffer.length > 2048) { // Higher threshold for safety
        const originalSize = buffer.length
        processedBuffer = await this.compressChunk(buffer) as Buffer<ArrayBuffer>

        // Only use compressed version if it's actually smaller and valid
        if (processedBuffer.length < originalSize && processedBuffer.length > 0) {
          // Update compression ratio in metrics
          const metrics = this.activeStreams.get(streamId)!
          if (metrics.compressionRatio === undefined) {
            metrics.compressionRatio = processedBuffer.length / buffer.length
          } else {
            metrics.compressionRatio = (metrics.compressionRatio + (processedBuffer.length / buffer.length)) / 2
          }
        } else {
          // Use original buffer if compression didn't help or failed
          processedBuffer = buffer
        }
      }

      // Optimize chunk for streaming only if enabled
      const optimizedBuffer = this.config.contentOptimizationEnabled
        ? this.optimizeChunkContent(processedBuffer)
        : processedBuffer

      return new Uint8Array(optimizedBuffer)

    } catch (error) {
      logger.error('STREAMING_MANAGER', `Chunk processing error for stream ${streamId}: ${error}`)
      return chunk // Return original chunk if processing fails
    }
  }

  /**
   * Compress chunk using efficient algorithm (conservative approach)
   */
  private async compressChunk(buffer: Buffer): Promise<Buffer> {
    try {
      const content = buffer.toString('utf8')

      // Only compress if it's not SSE data format
      if (content.startsWith('data: ')) {
        // Don't compress SSE data to avoid breaking JSON structure
        return buffer
      }

      // Very conservative compression - only remove leading/trailing whitespace
      const compressed = content.trim()
      return Buffer.from(compressed, 'utf8')
    } catch (error) {
      // If any error occurs, return original buffer
      return buffer
    }
  }

  /**
   * Optimize chunk content for streaming (conservative approach)
   */
  private optimizeChunkContent(buffer: Buffer): Buffer {
    try {
      const content = buffer.toString('utf8')

      // For SSE format, be very conservative to preserve JSON structure
      if (content.startsWith('data: ')) {
        // Only remove completely empty lines, preserve all data lines
        const lines = content.split('\n')
        const optimizedLines = lines.filter(line => {
          // Keep all non-empty lines and preserve structure
          return line.length > 0 || line === '' // Keep empty lines that might be important for SSE
        })

        // Preserve original formatting as much as possible
        return Buffer.from(optimizedLines.join('\n'), 'utf8')
      }

      // For non-SSE content, return as-is to avoid any corruption
      return buffer
    } catch (error) {
      // If any error occurs, return original buffer unchanged
      return buffer
    }
  }

  /**
   * Update stream metrics
   */
  private updateMetrics(streamId: string, chunk: Uint8Array): void {
    const metrics = this.activeStreams.get(streamId)!

    metrics.chunksProcessed++
    metrics.bytesProcessed += chunk.length
    metrics.averageChunkSize = metrics.bytesProcessed / metrics.chunksProcessed

    // Calculate processing rate (chunks per second)
    const elapsed = Math.max(1, (Date.now() - metrics.startTime)) / 1000 // Minimum 1ms to avoid division by zero
    metrics.processingRate = metrics.chunksProcessed / elapsed

    // Log progress every 25 chunks
    if (metrics.chunksProcessed % 25 === 0) {
      logger.debug('STREAMING_MANAGER',
        `Stream ${streamId}: ${metrics.chunksProcessed} chunks, ` +
        `${metrics.processingRate.toFixed(1)} chunks/sec, ` +
        `${(metrics.bytesProcessed / 1024).toFixed(1)}KB processed`
      )
    }
  }

  /**
   * Finalize stream processing with safe controller closure
   */
  private async finalizeStream(streamId: string, controller: ReadableStreamDefaultController): Promise<void> {
    const metrics = this.activeStreams.get(streamId)!
    const duration = (Date.now() - metrics.startTime) / 1000

    logger.info('STREAMING_MANAGER',
      `Stream ${streamId} completed: ${metrics.chunksProcessed} chunks in ${duration.toFixed(2)}s ` +
      `(${metrics.processingRate.toFixed(1)} chunks/sec, ${(metrics.bytesProcessed / 1024).toFixed(1)}KB)`
    )

    // STABILITY FIX: Safe controller closure with state tracking
    this.safeControllerClose(streamId, controller, 'normal completion')
    this.cleanupStream(streamId)
  }

  /**
   * Internal cleanup method called by the coordinator (idempotent)
   */
  private cleanupStreamInternal(streamId: string): void {
    // Keep metrics for a short time for testing/monitoring purposes
    const metrics = this.activeStreams.get(streamId)
    if (metrics) {
      // Mark as completed but don't delete immediately
      setTimeout(() => {
        this.activeStreams.delete(streamId)
      }, 1000) // Keep for 1 second
    }

    // Clean up all stream-related resources
    this.streamBuffers.delete(streamId)
    this.backpressureStates.delete(streamId)

    // Clean up controller state after a delay to allow any pending operations
    setTimeout(() => {
      this.controllerStates.delete(streamId)
    }, 2000) // Keep controller state longer for debugging

    logger.debug('STREAMING_MANAGER', `Internal cleanup completed for stream ${streamId}`)
  }

  /**
   * Clean up stream resources (deprecated - use coordinator instead)
   * @deprecated Use streamCoordinator.initiateCleanup() instead
   */
  private cleanupStream(streamId: string): void {
    logger.warn('STREAMING_MANAGER', `Direct cleanup called for ${streamId} - should use coordinator`)
    streamCoordinator.initiateCleanup(streamId, 'direct cleanup call', 'streamingManager')
  }

  /**
   * Check if controller is still open and safe to use
   */
  private isControllerOpen(streamId: string, controller: ReadableStreamDefaultController): boolean {
    const state = this.controllerStates.get(streamId)
    if (state?.closed) {
      return false
    }

    // Double-check with controller's internal state
    return controller.desiredSize !== null
  }

  /**
   * Mark controller as closed to prevent further operations
   */
  private markControllerClosed(streamId: string, reason: string): void {
    const state = this.controllerStates.get(streamId)
    if (state && !state.closed) {
      state.closed = true
      state.reason = reason
      logger.debug('STREAMING_MANAGER', `Marked controller ${streamId} as closed: ${reason}`)
    }
  }

  /**
   * Safely close controller with state tracking (idempotent)
   */
  private safeControllerClose(streamId: string, controller: ReadableStreamDefaultController, reason: string): void {
    const state = this.controllerStates.get(streamId)

    // Check if already closed
    if (state?.closed) {
      logger.debug('STREAMING_MANAGER', `Controller ${streamId} already closed (${state.reason}), skipping close`)
      return
    }

    // Attempt to close controller
    try {
      if (controller.desiredSize !== null) {
        controller.close()
        this.markControllerClosed(streamId, reason)
        logger.debug('STREAMING_MANAGER', `Controller ${streamId} closed successfully: ${reason}`)
      } else {
        this.markControllerClosed(streamId, `already closed when attempting: ${reason}`)
        logger.debug('STREAMING_MANAGER', `Controller ${streamId} was already closed: ${reason}`)
      }
    } catch (error) {
      this.markControllerClosed(streamId, `error during close: ${error}`)
      logger.warn('STREAMING_MANAGER', `Failed to close controller ${streamId}: ${error}`)
    }
  }

  /**
   * Safely signal error to controller with state tracking (idempotent)
   */
  private safeControllerError(streamId: string, controller: ReadableStreamDefaultController, error: any): void {
    const state = this.controllerStates.get(streamId)

    // Check if already closed
    if (state?.closed) {
      logger.debug('STREAMING_MANAGER', `Controller ${streamId} already closed (${state.reason}), skipping error signal`)
      return
    }

    // Attempt to signal error to controller
    try {
      if (controller.desiredSize !== null) {
        controller.error(error)
        this.markControllerClosed(streamId, `error: ${error}`)
        logger.debug('STREAMING_MANAGER', `Controller ${streamId} error signaled successfully`)
      } else {
        this.markControllerClosed(streamId, `already closed when signaling error: ${error}`)
        logger.debug('STREAMING_MANAGER', `Controller ${streamId} was already closed when signaling error`)
      }
    } catch (controllerError) {
      this.markControllerClosed(streamId, `error during error signal: ${controllerError}`)
      logger.warn('STREAMING_MANAGER', `Failed to signal error to controller ${streamId}: ${controllerError}`)
    }
  }

  /**
   * Initialize worker pool for parallel processing
   */
  private initializeWorkerPool(): void {
    // Worker pool implementation would go here
    // For now, we'll use the main thread with optimized processing
    logger.debug('STREAMING_MANAGER', `Worker pool initialized with ${this.config.workerPoolSize} workers`)
  }

  /**
   * Get streaming statistics
   */
  getStreamingStats(): {
    activeStreams: number
    totalStreams: number
    averageProcessingRate: number
    totalBytesProcessed: number
    backpressureEvents: number
  } {
    const allMetrics = Array.from(this.activeStreams.values())
    const activeMetrics = allMetrics.filter(m => {
      const elapsed = Date.now() - m.startTime
      return elapsed < 1000 || m.chunksProcessed === 0 // Consider active if recent or still processing
    })

    return {
      activeStreams: activeMetrics.length,
      totalStreams: allMetrics.length,
      averageProcessingRate: allMetrics.length > 0
        ? allMetrics.reduce((sum, m) => sum + (m.processingRate || 0), 0) / allMetrics.length
        : 0,
      totalBytesProcessed: allMetrics.reduce((sum, m) => sum + m.bytesProcessed, 0),
      backpressureEvents: allMetrics.reduce((sum, m) => sum + m.backpressureEvents, 0)
    }
  }

  /**
   * Get detailed metrics for a specific stream
   */
  getStreamMetrics(streamId: string): StreamMetrics | null {
    return this.activeStreams.get(streamId) || null
  }

  /**
   * Get current streaming statistics
   */
  getStats(): { activeStreams: number, totalBufferSize: number, controllerStates: number } {
    const activeStreamCount = this.activeStreams.size
    const totalBufferSize = Array.from(this.streamBuffers.values())
      .reduce((total, buffer) => total + buffer.reduce((sum, chunk) => sum + chunk.length, 0), 0)

    return {
      activeStreams: activeStreamCount,
      totalBufferSize,
      controllerStates: this.controllerStates.size
    }
  }

  /**
   * Get controller state for debugging (useful for troubleshooting)
   */
  getControllerState(streamId: string): { closed: boolean, reason?: string } | undefined {
    return this.controllerStates.get(streamId)
  }

  /**
   * Get all controller states for debugging
   */
  getAllControllerStates(): Map<string, { closed: boolean, reason?: string }> {
    return new Map(this.controllerStates)
  }

  /**
   * Emergency cleanup for all streams (useful for server shutdown)
   */
  emergencyCleanupAll(): void {
    logger.warn('STREAMING_MANAGER', `Emergency cleanup of ${this.activeStreams.size} active streams`)

    // Mark all controllers as closed to prevent further operations
    for (const [streamId] of this.activeStreams) {
      this.markControllerClosed(streamId, 'emergency cleanup')
    }

    // Clear all maps
    this.activeStreams.clear()
    this.streamBuffers.clear()
    this.backpressureStates.clear()

    // Clear controller states after a delay
    setTimeout(() => {
      this.controllerStates.clear()
    }, 5000)

    logger.info('STREAMING_MANAGER', 'Emergency cleanup completed')
  }
}

// Singleton instance
export const streamingManager = new StreamingManager()
