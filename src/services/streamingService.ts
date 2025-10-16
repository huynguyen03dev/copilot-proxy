/**
 * Consolidated Streaming Service
 * Handles all streaming request processing with unified architecture
 * 
 * PHASE 3: Consolidation of three streaming methods into one
 * - processStreamingResponse (deprecated) - REMOVED
 * - processStreamingResponseUnified - CONSOLIDATED
 * - processStreamingResponseOptimized - CONSOLIDATED
 */

import { logger, streamLogger, modelLogger } from '../utils/logger.js'
import { StreamingErrorBoundary } from '../utils/errorBoundary.js'
import { streamCoordinator } from '../utils/streamCoordinator.js'
import { streamingManager } from '../utils/streamingManager.js'
import { config } from '../config/index.js'
import { ChatCompletionRequest, ChatCompletionStreamChunk } from '../types.js'
import { ResponseTransformService } from './responseTransformService.js'
import { BufferAccumulator } from '../utils/bufferAccumulator.js'
import { stringifyStreamChunk } from '../utils/fastJsonStringify.js'

/**
 * Configuration options for streaming
 */
export interface StreamingOptions {
  /** Enable performance optimizations (streaming manager, adaptive backpressure, etc.) */
  useOptimizations?: boolean
  /** Maximum buffer size before splitting chunks */
  maxBufferSize?: number
  /** Timeout for chunks in milliseconds */
  chunkTimeout?: number
  /** API URL for logging */
  apiUrl?: string
}

const DEFAULT_STREAMING_OPTIONS: Required<StreamingOptions> = {
  useOptimizations: true,
  maxBufferSize: 64 * 1024, // 64KB
  chunkTimeout: 30000, // 30 seconds
  apiUrl: 'unknown'
}

/**
 * Consolidated Streaming Service
 * 
 * Merges all streaming logic into a single, configurable implementation:
 * - Unified buffer management
 * - Adaptive optimization level
 * - Consolidated backpressure handling
 * - Smart chunk splitting
 */
export class StreamingService {
  private responseTransformService: ResponseTransformService
  private streamMetrics: {
    totalChunks: number
    totalBytes: number
  }
  private decoder: TextDecoder // PERFORMANCE: Reuse TextDecoder instance

  constructor() {
    this.responseTransformService = new ResponseTransformService()
    this.streamMetrics = {
      totalChunks: 0,
      totalBytes: 0
    }
    this.decoder = new TextDecoder() // PERFORMANCE: Create once, reuse across streams
  }

  /**
   * CONSOLIDATED: Process streaming response with configurable optimization level
   * 
   * This method consolidates the logic from:
   * - processStreamingResponseUnified
   * - processStreamingResponseOptimized
   * - processStreamingResponse (deprecated)
   */
  async processStream(
    response: Response,
    stream: any,
    request: ChatCompletionRequest,
    streamId: string,
    options: StreamingOptions = {}
  ): Promise<void> {
    const opts = { ...DEFAULT_STREAMING_OPTIONS, ...options }
    const startTime = Date.now()

    if (!response.body) {
      throw new Error("No response body available")
    }

    // PERFORMANCE OPTIMIZATION: Use streaming manager for optimizations
    let reader: ReadableStreamDefaultReader<Uint8Array>
    
    if (opts.useOptimizations) {
      try {
        // Try to use optimized streaming manager
        const optimizedStream = await streamingManager.startStream(streamId, response.body)
        reader = optimizedStream.getReader()
        logger.debug('STREAMING', `Using optimized streaming manager for ${streamId}`)
      } catch (error) {
        logger.warn('STREAMING', `Failed to create optimized stream for ${streamId}, falling back to basic: ${error}`)
        reader = response.body.getReader()
        streamCoordinator.registerReader(streamId, reader)
      }
    } else {
      reader = response.body.getReader()
      streamCoordinator.registerReader(streamId, reader)
    }

    // PERFORMANCE OPTIMIZATION (Phase 3, Issue #3): Use BufferAccumulator to eliminate O(n²) concatenation
    const bufferAccumulator = new BufferAccumulator()
    let chunkCount = 0
    let lastActivityTime = Date.now()
    let actualModel: string | null = null
    let modelLogged = false

    // Handle client abort with guaranteed cleanup
    let isAborted = false
    let isTimedOut = false
    
    stream.onAbort(() => {
      logger.info('STREAM', `Client aborted streaming request ${streamId}`)
      isAborted = true
      // Release the local reader lock if present (safe and prevents leaks)
      try { reader.releaseLock() } catch {}
      // Use coordinator for abort cleanup
      streamCoordinator.initiateCleanup(streamId, 'client abort (consolidated)', 'streaming-service')
    })

    // STABILITY FIX: Set up chunk timeout monitoring without throwing inside setInterval
    // Use flag-based approach to avoid unhandled exceptions
    const chunkTimeoutInterval = setInterval(() => {
      if (Date.now() - lastActivityTime > opts.chunkTimeout) {
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
          logger.error('STREAM', `⏰ Stream ${streamId} timed out - no data received for ${opts.chunkTimeout / 1000} seconds`)
          throw new Error(`Streaming chunk timeout - no data received for ${opts.chunkTimeout / 1000} seconds`)
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
          if (opts.useOptimizations && Math.random() < 0.2) {
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

        // PERFORMANCE OPTIMIZATION (Phase 3, Issue #3): O(1) buffer append instead of O(n²) concat
        bufferAccumulator.add(value)
        lastActivityTime = Date.now()

        // Process complete lines from accumulated buffer
        const currentBuffer = bufferAccumulator.getBuffer()
        const { completeLines, remainingBuffer } = this.extractCompleteLines(currentBuffer)

        // Reset accumulator with remaining buffer
        bufferAccumulator.clear()
        if (remainingBuffer.length > 0) {
          bufferAccumulator.add(remainingBuffer)
        }

        for (const line of completeLines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              await stream.writeSSE({ data: '[DONE]' })

              // STABILITY FIX: Use coordinator for [DONE] cleanup to prevent race conditions
              logger.info('STREAM', `✅ Stream ${streamId} finished with [DONE] signal${actualModel ? ` (model: ${actualModel})` : ''}`)
              await streamCoordinator.initiateCleanup(streamId, 'done signal', 'streaming-service')
              return
            }

            // Process chunk with error boundary
            const chunkResult = StreamingErrorBoundary.handleChunkProcessing(
              () => {
                const chunk = JSON.parse(data)

                // Capture the actual model from the first chunk
                if (!modelLogged && chunk.model) {
                  actualModel = chunk.model
                  modelLogger.info(streamId, chunk.model, opts.apiUrl)
                  modelLogged = true
                }

                const transformedChunk = this.responseTransformService.transformStreamChunk(chunk, request)
                // PERFORMANCE OPTIMIZATION (Phase 3, Issue #12): Use fast-json-stringify for 2-3x faster serialization
                return {
                  chunk,
                  transformedChunk,
                  chunkData: stringifyStreamChunk(transformedChunk)
                }
              },
              streamId,
              chunkCount
            )

            if (chunkResult.success && chunkResult.data) {
              try {
                // CONSOLIDATED: Use appropriate backpressure handling based on optimization level
                await this.writeWithBackpressure(
                  stream,
                  chunkResult.data.chunkData,
                  streamId,
                  opts.useOptimizations,
                  opts.maxBufferSize
                )

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
              // Use configured frequency, or default to 50 chunks for reasonable output
              const logFrequency = config.logging.chunkLogFrequency || 50
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
      logger.error('STREAM', `❌ Error processing stream ${streamId}: ${error}`)
      throw error
    } finally {
      clearInterval(chunkTimeoutInterval)
      await streamCoordinator.initiateCleanup(streamId, 'finally (consolidated)', 'streaming-service')
    }
  }

  /**
   * PERFORMANCE OPTIMIZATION: Extract complete lines from buffer efficiently
   * Uses indexOf loop instead of split to avoid array allocation overhead
   * Handles both \n and \r\n line endings
   */
  private extractCompleteLines(buffer: Buffer): { completeLines: string[]; remainingBuffer: Buffer } {
    // PERFORMANCE: Reuse class-level decoder with stream:true for proper handling
    const text = this.decoder.decode(buffer, { stream: true })
    const lines: string[] = []
    let start = 0
    let pos = 0

    // PERFORMANCE: Use indexOf loop instead of split to avoid array allocation
    while ((pos = text.indexOf('\n', start)) !== -1) {
      let lineEnd = pos
      // Handle CRLF (\r\n) line endings
      if (lineEnd > 0 && text[lineEnd - 1] === '\r') {
        lineEnd--
      }
      lines.push(text.substring(start, lineEnd))
      start = pos + 1
    }

    // Remaining text after last newline (incomplete line)
    const remainingText = text.substring(start)
    const remainingBuffer = Buffer.from(remainingText)

    return {
      completeLines: lines,
      remainingBuffer
    }
  }

  /**
   * CONSOLIDATED: Write with adaptive backpressure handling
   * 
   * Merges logic from:
   * - writeWithBackpressure (basic)
   * - writeWithBackpressureOptimized (advanced with adaptive sizing)
   */
  private async writeWithBackpressure(
    stream: any,
    data: string,
    streamId: string,
    useOptimizations: boolean,
    maxBufferSize: number
  ): Promise<void> {
    let effectiveBufferSize = maxBufferSize

    // OPTIMIZATION: Adaptive buffer sizing based on stream performance
    if (useOptimizations) {
      const streamMetrics = streamingManager.getStreamMetrics(streamId)
      
      if (streamMetrics) {
        // Reduce buffer size if backpressure events are frequent
        if (streamMetrics.backpressureEvents > 5) {
          effectiveBufferSize = Math.floor(maxBufferSize * 0.7)
        }

        // Increase buffer size for high-performing streams
        if (streamMetrics.processingRate > 10 && streamMetrics.backpressureEvents === 0) {
          effectiveBufferSize = Math.floor(maxBufferSize * 1.3)
        }
      }
    }

    // Check if data size exceeds buffer limit
    if (data.length > effectiveBufferSize) {
      if (useOptimizations) {
        logger.debug('STREAMING',
          `Large chunk detected in ${streamId}: ${data.length} bytes (limit: ${effectiveBufferSize})`
        )
      } else {
        logger.warn('STREAMING', `⚠️ Large chunk detected in ${streamId}: ${data.length} bytes`)
      }

      // CONSOLIDATED: Use appropriate chunk splitting strategy
      const chunks = useOptimizations
        ? this.splitLargeChunkOptimized(data, effectiveBufferSize)
        : this.splitLargeChunk(data, maxBufferSize)

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        await stream.writeSSE({ data: chunk })

        // PERFORMANCE OPTIMIZATION: Adaptive delay based on backpressure
        if (useOptimizations) {
          const streamMetrics = streamingManager.getStreamMetrics(streamId)
          
          // Only delay when there's actual backpressure
          if (streamMetrics && streamMetrics.backpressureEvents > 0) {
            // Longer delay if backpressure is active
            const delay = Math.min(10, streamMetrics.backpressureEvents)
            await new Promise(resolve => setTimeout(resolve, delay))
          } else if (chunks.length > 50 && i < chunks.length - 1) {
            // Very minimal delay only for extremely large chunk sequences
            await new Promise(resolve => setTimeout(resolve, 0.1))
          }
        } else {
          // Basic mode: minimal delay for very large sequences
          if (chunks.length > 20 && i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 0.5))
          }
        }
      }
    } else {
      await stream.writeSSE({ data })
    }
  }

  /**
   * CONSOLIDATED: Split large chunks into smaller pieces (basic strategy)
   */
  private splitLargeChunk(data: string, maxBufferSize: number): string[] {
    const chunks: string[] = []
    const maxChunkSize = Math.floor(maxBufferSize / 2) // Use half of max buffer

    for (let i = 0; i < data.length; i += maxChunkSize) {
      chunks.push(data.slice(i, i + maxChunkSize))
    }

    return chunks
  }

  /**
   * CONSOLIDATED: Optimized chunk splitting with adaptive sizing and JSON boundary awareness
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
   * Get accumulated streaming metrics
   */
  getMetrics(): { totalChunks: number; totalBytes: number } {
    return { ...this.streamMetrics }
  }

  /**
   * Reset streaming metrics
   */
  resetMetrics(): void {
    this.streamMetrics.totalChunks = 0
    this.streamMetrics.totalBytes = 0
  }
}

/**
 * Singleton instance for convenience
 */
export const streamingService = new StreamingService()