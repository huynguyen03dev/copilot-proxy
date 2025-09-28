/**
 * Global Stream Coordinator
 * Manages the complete lifecycle of streaming operations across all layers
 * Prevents race conditions and double-cleanup issues
 */

import { logger } from './logger.js'

export interface StreamState {
  streamId: string
  status: 'active' | 'completing' | 'completed' | 'aborted' | 'error'
  createdAt: number
  completedAt?: number
  reason?: string
  layers: {
    httpStream?: boolean      // Underlying HTTP stream from GitHub API
    streamingManager?: boolean // Our streaming manager wrapper
    serverCleanup?: boolean   // Server-level cleanup
    honoSSE?: boolean        // Hono's SSE stream
  }
  readers: Set<ReadableStreamDefaultReader<any>>
  controllers: Set<ReadableStreamDefaultController<any>>
  cleanupCallbacks: Array<() => Promise<void> | void>
}

class StreamCoordinator {
  private streams = new Map<string, StreamState>()
  private cleanupInProgress = new Set<string>()

  /**
   * Register a new stream with the coordinator
   */
  registerStream(streamId: string): StreamState {
    if (this.streams.has(streamId)) {
      logger.warn('STREAM_COORDINATOR', `Stream ${streamId} already registered`)
      return this.streams.get(streamId)!
    }

    const state: StreamState = {
      streamId,
      status: 'active',
      createdAt: Date.now(),
      layers: {},
      readers: new Set(),
      controllers: new Set(),
      cleanupCallbacks: []
    }

    this.streams.set(streamId, state)
    logger.debug('STREAM_COORDINATOR', `Registered stream ${streamId}`)
    return state
  }

  /**
   * Register a reader with the stream (for proper cleanup)
   */
  registerReader(streamId: string, reader: ReadableStreamDefaultReader<any>): void {
    const state = this.streams.get(streamId)
    if (state) {
      state.readers.add(reader)
      logger.debug('STREAM_COORDINATOR', `Registered reader for stream ${streamId}`)
    }
  }

  /**
   * Register a controller with the stream (for proper cleanup)
   */
  registerController(streamId: string, controller: ReadableStreamDefaultController<any>): void {
    const state = this.streams.get(streamId)
    if (state) {
      state.controllers.add(controller)
      logger.debug('STREAM_COORDINATOR', `Registered controller for stream ${streamId}`)
    }
  }

  /**
   * Register a cleanup callback for the stream
   */
  registerCleanupCallback(streamId: string, callback: () => Promise<void> | void): void {
    const state = this.streams.get(streamId)
    if (state) {
      state.cleanupCallbacks.push(callback)
    }
  }

  /**
   * Mark a layer as active for the stream
   */
  markLayerActive(streamId: string, layer: keyof StreamState['layers']): void {
    const state = this.streams.get(streamId)
    if (state) {
      state.layers[layer] = true
      logger.debug('STREAM_COORDINATOR', `Marked layer ${layer} active for stream ${streamId}`)
    }
  }

  /**
   * Initiate coordinated cleanup for a stream (idempotent)
   */
  async initiateCleanup(streamId: string, reason: string, initiatingLayer?: string): Promise<void> {
    const state = this.streams.get(streamId)
    if (!state) {
      logger.debug('STREAM_COORDINATOR', `Stream ${streamId} not found for cleanup`)
      return
    }

    // Prevent multiple concurrent cleanup operations
    if (this.cleanupInProgress.has(streamId)) {
      logger.debug('STREAM_COORDINATOR', `Cleanup already in progress for stream ${streamId}`)
      return
    }

    // Mark as completing to prevent new operations
    if (state.status === 'active') {
      state.status = 'completing'
      state.reason = reason
      logger.info('STREAM_COORDINATOR', `Initiating cleanup for stream ${streamId}: ${reason} (from ${initiatingLayer || 'unknown'})`)
    } else {
      logger.debug('STREAM_COORDINATOR', `Stream ${streamId} already completing/completed, skipping cleanup`)
      return
    }

    this.cleanupInProgress.add(streamId)

    try {
      // 1. Release all readers safely (do NOT cancel upstream to avoid undici double-close)
      for (const reader of state.readers) {
        try {
          reader.releaseLock()
          logger.debug('STREAM_COORDINATOR', `Released reader lock for stream ${streamId}`)
        } catch (error) {
          logger.debug('STREAM_COORDINATOR', `Reader lock already released for stream ${streamId}: ${error}`)
        }
      }

      // 2. Close all controllers safely (wrapper controllers only)
      for (const controller of state.controllers) {
        try {
          // desiredSize can be non-null even when closed; wrap with try/catch
          controller.close()
          logger.debug('STREAM_COORDINATOR', `Closed controller for stream ${streamId}`)
        } catch (error) {
          logger.debug('STREAM_COORDINATOR', `Controller already closed for stream ${streamId}: ${error}`)
        }
      }

      // 3. Execute all cleanup callbacks
      for (const callback of state.cleanupCallbacks) {
        try {
          await callback()
        } catch (error) {
          logger.warn('STREAM_COORDINATOR', `Cleanup callback failed for stream ${streamId}: ${error}`)
        }
      }

      // 4. Mark as completed
      state.status = 'completed'
      state.completedAt = Date.now()
      
      logger.info('STREAM_COORDINATOR', `Cleanup completed for stream ${streamId}`)

    } catch (error) {
      state.status = 'error'
      logger.error('STREAM_COORDINATOR', `Cleanup failed for stream ${streamId}: ${error}`)
    } finally {
      this.cleanupInProgress.delete(streamId)
      
      // Clean up the state after a delay (for debugging)
      setTimeout(() => {
        this.streams.delete(streamId)
      }, 5000)
    }
  }

  /**
   * Check if a stream is safe to operate on
   */
  isStreamActive(streamId: string): boolean {
    const state = this.streams.get(streamId)
    return state?.status === 'active'
  }

  /**
   * Get stream state for debugging
   */
  getStreamState(streamId: string): StreamState | undefined {
    return this.streams.get(streamId)
  }

  /**
   * Get all stream states for debugging
   */
  getAllStreamStates(): Map<string, StreamState> {
    return new Map(this.streams)
  }

  /**
   * Emergency cleanup all streams
   */
  async emergencyCleanupAll(): Promise<void> {
    logger.warn('STREAM_COORDINATOR', `Emergency cleanup of ${this.streams.size} streams`)
    
    const cleanupPromises = Array.from(this.streams.keys()).map(streamId =>
      this.initiateCleanup(streamId, 'emergency cleanup', 'coordinator')
    )
    
    await Promise.allSettled(cleanupPromises)
    logger.info('STREAM_COORDINATOR', 'Emergency cleanup completed')
  }
}

// Singleton instance
export const streamCoordinator = new StreamCoordinator()
