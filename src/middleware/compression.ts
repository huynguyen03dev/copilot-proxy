import { Context, Next } from "hono"
import { gzip, deflate, createGzip, createDeflate } from "zlib"
import { promisify } from "util"
import { pipeline } from "stream/promises"
import { Readable, PassThrough } from "stream"
import { logger } from "../utils/logger.js"

const gzipAsync = promisify(gzip)
const deflateAsync = promisify(deflate)

export interface CompressionConfig {
  threshold: number
  enableForSSE: boolean
  trackStats: boolean
  algorithms: string[]
  skipApiEndpoints: boolean // Skip compression for API JSON responses to avoid buffering
  enableStreamingCompression: boolean // PERFORMANCE (Phase 4, Issue #8): Enable streaming compression for large responses
  streamingThreshold: number // Size threshold for streaming compression (bytes)
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  threshold: 24 * 1024, // 24KB — reduce recompression costs for medium responses
  enableForSSE: false, // Disable for SSE to prevent streaming issues
  trackStats: true,
  algorithms: ['gzip', 'deflate'],
  skipApiEndpoints: false, // Allow compression for API endpoints in development
  enableStreamingCompression: false, // Disabled in dev for simplicity
  streamingThreshold: 256 * 1024 // 256KB
}

export const PRODUCTION_COMPRESSION_CONFIG: CompressionConfig = {
  threshold: 4096, // 4KB minimum for production - balance between efficiency and overhead
  enableForSSE: false, // Disable for SSE to prevent streaming issues
  trackStats: true,
  algorithms: ['gzip', 'deflate'],
  skipApiEndpoints: true, // Skip compression for API endpoints to avoid buffering overhead
  enableStreamingCompression: true, // PERFORMANCE (Phase 4, Issue #8): Enable streaming compression
  streamingThreshold: 256 * 1024 // 256KB - use streaming for large responses
}

function isApiEndpoint(path: string): boolean {
  const apiPatterns = [
    '/v1/', '/api/', '/auth/', '/health', '/metrics', '/status', '/openapi', '/docs'
  ]
  return apiPatterns.some(pattern => path.startsWith(pattern) || path === pattern.slice(0, -1))
}

function isStreamingResponse(c: Context): boolean {
  const contentType = c.res.headers.get('content-type') || ''
  const path = c.req.path
  if (contentType.includes('text/event-stream')) return true
  if (contentType.includes('multipart/') || path.includes('/stream')) return true
  return false
}

export function compressionMiddleware(config: Partial<CompressionConfig> = {}) {
  const finalConfig = { ...DEFAULT_COMPRESSION_CONFIG, ...config }

  return async (c: Context, next: Next) => {
    await next()

    // Skip compression for streaming responses
    if (isStreamingResponse(c)) {
      if (finalConfig.trackStats) {
        logger.debug('COMPRESSION', `Skipping compression for streaming response: ${c.req.path}`)
      }
      return
    }

    // PERFORMANCE: Skip compression for API endpoints to avoid buffering
    if (finalConfig.skipApiEndpoints && isApiEndpoint(c.req.path)) {
      if (finalConfig.trackStats) {
        logger.debug('COMPRESSION', `Skipping compression for API endpoint: ${c.req.path}`)
      }
      return
    }

    const acceptEncoding = c.req.header('accept-encoding') || ''
    const contentType = c.res.headers.get('content-type') || ''

    if (!acceptEncoding.includes('gzip') && !acceptEncoding.includes('deflate')) return
    if (!isCompressibleContentType(contentType)) return

    // Get response body
    let responseBody: string
    try {
      responseBody = await c.res.text()
    } catch (error) {
      if (finalConfig.trackStats) {
        logger.debug('COMPRESSION', `Cannot read response body, skipping compression: ${error}`)
      }
      return
    }

    const originalSize = new TextEncoder().encode(responseBody).length

    if (originalSize < finalConfig.threshold) {
      if (finalConfig.trackStats) {
        logger.debug('COMPRESSION', `Skipping compression: below threshold (${originalSize} < ${finalConfig.threshold} bytes)`)
      }
      c.res = new Response(responseBody, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers })
      return
    }

    const algorithm = acceptEncoding.includes('gzip') ? 'gzip' : 'deflate'

    // PERFORMANCE OPTIMIZATION (Phase 4, Issue #8): Streaming compression for large responses
    if (finalConfig.enableStreamingCompression && originalSize >= finalConfig.streamingThreshold) {
      try {
        if (finalConfig.trackStats) {
          logger.debug('COMPRESSION', `Using streaming compression for large response: ${originalSize} bytes`)
        }

        const buffer = Buffer.from(responseBody, 'utf8')
        const readable = Readable.from([buffer])
        const compressor = algorithm === 'gzip' ? createGzip() : createDeflate()

        const headers = new Headers(c.res.headers)
        headers.set('content-encoding', algorithm)
        headers.set('vary', 'Accept-Encoding')
        headers.delete('content-length') // Remove content-length for streaming

        // Create streaming response
        const stream = readable.pipe(compressor)
        c.res = new Response(stream as any, {
          status: c.res.status,
          statusText: c.res.statusText,
          headers
        })

        if (finalConfig.trackStats) {
          logger.info('COMPRESSION', `Streaming ${algorithm.toUpperCase()} compression for ${originalSize} bytes`)
        }
        return
      } catch (error) {
        logger.warn('COMPRESSION', `Streaming compression failed, falling back to buffered: ${error}`)
        // Fall through to buffered compression
      }
    }

    // Buffered compression for small/medium responses
    try {
      const buffer = Buffer.from(responseBody, 'utf8')
      const compressedBuffer = algorithm === 'gzip' ? await gzipAsync(buffer) : await deflateAsync(buffer)

      if (compressedBuffer.length < originalSize) {
        const headers = new Headers(c.res.headers)
        headers.set('content-encoding', algorithm)
        headers.set('content-length', compressedBuffer.length.toString())
        headers.set('vary', 'Accept-Encoding')

        c.res = new Response(compressedBuffer as BodyInit, { status: c.res.status, statusText: c.res.statusText, headers })

        if (finalConfig.trackStats) {
          if (Math.random() < 0.1) {
            logger.info('COMPRESSION', `${algorithm.toUpperCase()}: ${originalSize} → ${compressedBuffer.length} bytes`)
          } else {
            logger.debug('COMPRESSION', `${algorithm.toUpperCase()}: ${originalSize} → ${compressedBuffer.length} bytes`)
          }
        }
      } else {
        if (finalConfig.trackStats) logger.debug('COMPRESSION', `Compression increased size, using original response`)
        c.res = new Response(responseBody, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers })
      }
    } catch (error) {
      logger.warn('COMPRESSION', `Compression failed: ${error}`)
      c.res = new Response(responseBody, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers })
    }
  }
}

function isCompressibleContentType(contentType: string): boolean {
  const compressibleTypes = [
    'text/', 'application/json', 'application/javascript', 'application/xml', 'application/rss+xml', 'application/atom+xml', 'image/svg+xml', 'text/event-stream'
  ]
  const nonCompressibleTypes = [
    'image/', 'video/', 'audio/', 'application/zip', 'application/gzip', 'application/x-rar', 'application/pdf'
  ]
  if (nonCompressibleTypes.some(type => contentType.includes(type))) return false
  return compressibleTypes.some(type => contentType.includes(type))
}

