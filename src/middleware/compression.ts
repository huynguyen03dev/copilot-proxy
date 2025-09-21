import { Context, Next } from "hono"
import { gzip, deflate } from "zlib"
import { promisify } from "util"
import { logger } from "../utils/logger"

const gzipAsync = promisify(gzip)
const deflateAsync = promisify(deflate)

export interface CompressionConfig {
  threshold: number
  enableForSSE: boolean
  trackStats: boolean
  algorithms: string[]
  skipApiEndpoints: boolean // Skip compression for API JSON responses to avoid buffering
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  threshold: 24 * 1024, // 24KB — reduce recompression costs for medium responses
  enableForSSE: false, // Disable for SSE to prevent streaming issues
  trackStats: true,
  algorithms: ['gzip', 'deflate'],
  skipApiEndpoints: false // Allow compression for API endpoints in development
}

export const PRODUCTION_COMPRESSION_CONFIG: CompressionConfig = {
  threshold: 4096, // 4KB minimum for production - balance between efficiency and overhead
  enableForSSE: false, // Disable for SSE to prevent streaming issues
  trackStats: true,
  algorithms: ['gzip', 'deflate'],
  skipApiEndpoints: true // Skip compression for API endpoints to avoid buffering overhead
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

    try {
      const buffer = Buffer.from(responseBody, 'utf8')
      const compressedBuffer = algorithm === 'gzip' ? await gzipAsync(buffer) : await deflateAsync(buffer)

      if (compressedBuffer.length < originalSize) {
        const headers = new Headers(c.res.headers)
        headers.set('content-encoding', algorithm)
        headers.set('content-length', compressedBuffer.length.toString())
        headers.set('vary', 'Accept-Encoding')

        c.res = new Response(new Uint8Array(compressedBuffer as any), { status: c.res.status, statusText: c.res.statusText, headers })

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

