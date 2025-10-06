/**
 * Unified Response Middleware
 * PERFORMANCE OPTIMIZATION (Phase 4, Issue #4):
 * Combines response body processing to avoid double reads
 * - Single read of response body
 * - Applies ETag generation (conditional, size-gated)
 * - Applies compression (conditional, size-gated)
 * - Supports streaming and binary responses
 */

import { Context, Next } from "hono"
import { createHash } from "crypto"
import { gzip, deflate } from "zlib"
import { promisify } from "util"
import { logger } from "../utils/logger.js"

const gzipAsync = promisify(gzip)
const deflateAsync = promisify(deflate)

export interface UnifiedResponseConfig {
  // ETag configuration
  enableETags: boolean
  etagMaxSize: number // Max response size for ETag generation (bytes)
  etagSafeEndpoints: string[] // Endpoints safe for ETag generation
  
  // Compression configuration
  enableCompression: boolean
  compressionThreshold: number // Min size for compression (bytes)
  compressionAlgorithms: string[]
  skipCompressionForApi: boolean
  
  // General
  trackStats: boolean
}

export const DEFAULT_UNIFIED_RESPONSE_CONFIG: UnifiedResponseConfig = {
  enableETags: true,
  etagMaxSize: 32 * 1024, // 32KB
  etagSafeEndpoints: ['/', '/v1/models'],
  enableCompression: true,
  compressionThreshold: 4096, // 4KB
  compressionAlgorithms: ['gzip', 'deflate'],
  skipCompressionForApi: false,
  trackStats: true
}

export const PRODUCTION_UNIFIED_RESPONSE_CONFIG: UnifiedResponseConfig = {
  ...DEFAULT_UNIFIED_RESPONSE_CONFIG,
  etagMaxSize: 32 * 1024, // 32KB - Issue #6
  compressionThreshold: 4096, // 4KB
  skipCompressionForApi: true
}

/**
 * Check if endpoint is safe for ETag generation
 */
function isETagSafeEndpoint(path: string, safeEndpoints: string[]): boolean {
  return safeEndpoints.some(endpoint => path === endpoint || path.startsWith(endpoint))
}

/**
 * Check if response is streaming
 */
function isStreamingResponse(c: Context): boolean {
  const contentType = c.res.headers.get('content-type') || ''
  const path = c.req.path
  return contentType.includes('text/event-stream') || 
         contentType.includes('multipart/') || 
         path.includes('/stream')
}

/**
 * Check if content type is compressible
 */
function isCompressibleContentType(contentType: string): boolean {
  const compressibleTypes = [
    'text/', 'application/json', 'application/javascript', 
    'application/xml', 'application/rss+xml', 'application/atom+xml', 
    'image/svg+xml'
  ]
  const nonCompressibleTypes = [
    'image/', 'video/', 'audio/', 'application/zip', 
    'application/gzip', 'application/x-rar', 'application/pdf'
  ]
  
  if (nonCompressibleTypes.some(type => contentType.includes(type))) return false
  return compressibleTypes.some(type => contentType.includes(type))
}

/**
 * Check if endpoint is an API endpoint
 */
function isApiEndpoint(path: string): boolean {
  const apiPatterns = [
    '/v1/', '/api/', '/auth/', '/health', '/metrics', '/status', '/openapi', '/docs'
  ]
  return apiPatterns.some(pattern => path.startsWith(pattern) || path === pattern.slice(0, -1))
}

/**
 * Generate ETag for content
 */
function generateETag(content: string | Buffer): string {
  const hash = createHash('md5')
  
  if (typeof content === 'string') {
    hash.update(content, 'utf8')
  } else {
    hash.update(content)
  }
  
  return `"${hash.digest('hex')}"`
}

/**
 * Unified response middleware
 * PERFORMANCE: Single read, single pass processing
 */
export function unifiedResponseMiddleware(config: Partial<UnifiedResponseConfig> = {}) {
  const finalConfig = { ...DEFAULT_UNIFIED_RESPONSE_CONFIG, ...config }

  return async (c: Context, next: Next) => {
    await next()

    // Skip for streaming responses
    if (isStreamingResponse(c)) {
      if (finalConfig.trackStats) {
        logger.debug('UNIFIED_RESPONSE', `Skipping unified processing for streaming: ${c.req.path}`)
      }
      return
    }

    const path = c.req.path
    const method = c.req.method
    const contentType = c.res.headers.get('content-type') || ''
    const acceptEncoding = c.req.header('accept-encoding') || ''
    
    // PERFORMANCE: Single read of response body
    let responseBody: string
    try {
      responseBody = await c.res.text()
    } catch (error) {
      if (finalConfig.trackStats) {
        logger.debug('UNIFIED_RESPONSE', `Cannot read response body: ${error}`)
      }
      return
    }

    const originalSize = Buffer.byteLength(responseBody, 'utf8')
    const headers = new Headers(c.res.headers)
    
    // PERFORMANCE OPTIMIZATION (Phase 4, Issue #6): Conditional ETag generation
    // Only generate ETags for small responses on safe endpoints
    let shouldGenerateETag = false
    if (finalConfig.enableETags && 
        method === 'GET' && 
        !headers.get('content-encoding') &&
        isETagSafeEndpoint(path, finalConfig.etagSafeEndpoints) &&
        originalSize <= finalConfig.etagMaxSize) {
      shouldGenerateETag = true
    }

    if (shouldGenerateETag) {
      const etag = generateETag(responseBody)
      headers.set('ETag', etag)
      headers.set('Cache-Control', 'public, max-age=300, must-revalidate')
      
      if (finalConfig.trackStats) {
        logger.debug('UNIFIED_RESPONSE', `Generated ETag for ${path}: ${etag}`)
      }
      
      // Check if-none-match for 304 response
      const ifNoneMatch = c.req.header('if-none-match')
      if (ifNoneMatch === etag) {
        return c.body(null, 304, Object.fromEntries(headers.entries()))
      }
    }

    // PERFORMANCE: Compression decision
    let shouldCompress = false
    if (finalConfig.enableCompression &&
        originalSize >= finalConfig.compressionThreshold &&
        isCompressibleContentType(contentType) &&
        (acceptEncoding.includes('gzip') || acceptEncoding.includes('deflate')) &&
        !(finalConfig.skipCompressionForApi && isApiEndpoint(path))) {
      shouldCompress = true
    }

    if (shouldCompress) {
      const algorithm = acceptEncoding.includes('gzip') ? 'gzip' : 'deflate'
      
      try {
        const buffer = Buffer.from(responseBody, 'utf8')
        const compressedBuffer = algorithm === 'gzip' 
          ? await gzipAsync(buffer) 
          : await deflateAsync(buffer)

        if (compressedBuffer.length < originalSize) {
          headers.set('content-encoding', algorithm)
          headers.set('content-length', compressedBuffer.length.toString())
          headers.set('vary', 'Accept-Encoding')

          c.res = new Response(compressedBuffer as BodyInit, {
            status: c.res.status,
            statusText: c.res.statusText,
            headers
          })

          if (finalConfig.trackStats && Math.random() < 0.1) {
            logger.info('UNIFIED_RESPONSE', 
              `${algorithm.toUpperCase()}: ${originalSize} → ${compressedBuffer.length} bytes (${path})`
            )
          }
          return
        }
      } catch (error) {
        logger.warn('UNIFIED_RESPONSE', `Compression failed: ${error}`)
      }
    }

    // Return uncompressed response with updated headers
    c.res = new Response(responseBody, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers
    })
    return
  }
}

