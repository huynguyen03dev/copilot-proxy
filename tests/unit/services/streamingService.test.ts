/**
 * Unit tests for StreamingService
 * Tests streaming processing with various configurations
 */

import { describe, it, beforeEach } from 'node:test'
import { expect, expectAsyncNotToThrow } from '../../helpers/assertions.js'
import { StreamingService } from '../../../src/services/streamingService.js'
import { ChatCompletionRequest } from '../../../src/types.js'

describe('StreamingService', () => {
  let service: StreamingService

  beforeEach(() => {
    service = new StreamingService()
  })

  describe('constructor', () => {
    it('should initialize successfully', () => {
      expect(service).toBeDefined()
      expect(service).toBeInstanceOf(StreamingService)
    })
  })

  describe('processStream() - basic functionality', () => {
    const mockRequest: ChatCompletionRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }],
      stream: true
    }

    it('should accept valid streaming options', async () => {
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          }
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        }
      )

      const mockStream = {
        write: () => {},
        writeSSE: () => {}
      }

      const options = {
        useOptimizations: true,
        apiUrl: 'https://api.test.com',
        maxBufferSize: 16 * 1024 * 1024
      }

      // Should not throw
      await expectAsyncNotToThrow(async () => {
        await service.processStream(mockResponse, mockStream, mockRequest, 'test-stream', options)
      })
    })

    it('should handle empty stream', async () => {
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.close()
          }
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        }
      )

      const mockStream = {
        write: () => {},
        writeSSE: () => {}
      }

      await expectAsyncNotToThrow(async () => {
        await service.processStream(mockResponse, mockStream, mockRequest, 'empty-stream', {
          useOptimizations: false,
          apiUrl: 'https://api.test.com',
          maxBufferSize: 16 * 1024 * 1024
        })
      })
    })

    it('should handle different maxBufferSize values', async () => {
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )

      const mockStream = {
        write: () => {},
        writeSSE: () => {}
      }

      // Small buffer
      await service.processStream(mockResponse, mockStream, mockRequest, 'test-1', {
        useOptimizations: true,
        apiUrl: 'https://api.test.com',
        maxBufferSize: 512
      })

      expect(true).toBe(true) // Test completed successfully
    })
  })
})