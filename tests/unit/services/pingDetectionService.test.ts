/**
 * Unit tests for PingDetectionService
 * Tests ping detection heuristics and handling modes
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { PingDetectionService } from '../../../src/services/pingDetectionService'
import { ChatCompletionRequest } from '../../../src/types'

describe('PingDetectionService', () => {
  let service: PingDetectionService

  beforeEach(() => {
    // Reset service with default configuration
    service = new PingDetectionService({ mode: 'off', minStreamTokens: 4 })
  })

  describe('detectPing()', () => {
    it('should detect simple ping request', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(true)
    })

    it('should detect "hello" as ping', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(true)
    })

    it('should detect "hi" as ping', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(true)
    })

    it('should detect "test" as ping', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(true)
    })

    it('should NOT detect ping for non-streaming request', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'ping' }],
        stream: false, // Not streaming
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(false)
    })

    it('should NOT detect ping when temperature is not 0', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        temperature: 0.7, // Not 0
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(false)
    })

    it('should NOT detect ping for long messages', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'this is a long message' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(false)
    })

    it('should NOT detect ping for multiple messages', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'assistant', content: 'pong' }
        ],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(false)
    })

    it('should NOT detect ping for non-ping keywords', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'code' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(false)
    })

    it('should handle uppercase ping', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'PING' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(true)
    })

    it('should handle ping with whitespace', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: '  ping  ' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(true)
    })
  })

  describe('handlePing() - off mode', () => {
    beforeEach(() => {
      service = new PingDetectionService({ mode: 'off', minStreamTokens: 4 })
    })

    it('should return isPing=true but not modify request in off mode', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      const result = service.handlePing(request)

      expect(result.isPing).toBe(true)
      expect(result.modifiedRequest.max_tokens).toBe(1) // Not modified
      expect(result.pingText).toBe('ping')
    })

    it('should return isPing=false for non-ping requests', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'explain quantum physics' }],
        stream: true,
        temperature: 0.7,
        max_tokens: 100
      }

      const result = service.handlePing(request)

      expect(result.isPing).toBe(false)
    })
  })

  describe('handlePing() - enhance mode', () => {
    beforeEach(() => {
      service = new PingDetectionService({ mode: 'enhance', minStreamTokens: 4 })
    })

    it('should enhance max_tokens for ping requests', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      const result = service.handlePing(request)

      expect(result.isPing).toBe(true)
      expect(result.modifiedRequest.max_tokens).toBe(4) // Enhanced from 1 to 4
      expect(result.pingText).toBe('ping')
    })

    it('should use minStreamTokens configuration', () => {
      service = new PingDetectionService({ mode: 'enhance', minStreamTokens: 10 })

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      const result = service.handlePing(request)

      expect(result.modifiedRequest.max_tokens).toBe(10) // Enhanced to 10
    })

    it('should NOT enhance if max_tokens is already high', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        temperature: 0,
        max_tokens: 100 // Already high
      }

      const result = service.handlePing(request)

      expect(result.isPing).toBe(true)
      expect(result.modifiedRequest.max_tokens).toBe(100) // Not modified (> minStreamTokens)
    })
  })

  describe('getConfig() and updateConfig()', () => {
    it('should return current configuration', () => {
      const config = service.getConfig()

      expect(config.mode).toBe('off')
      expect(config.minStreamTokens).toBe(4)
    })

    it('should update configuration', () => {
      service.updateConfig({ mode: 'enhance', minStreamTokens: 8 })

      const config = service.getConfig()

      expect(config.mode).toBe('enhance')
      expect(config.minStreamTokens).toBe(8)
    })

    it('should partial update configuration', () => {
      service.updateConfig({ mode: 'suppress' })

      const config = service.getConfig()

      expect(config.mode).toBe('suppress')
      expect(config.minStreamTokens).toBe(4) // Unchanged
    })
  })

  describe('edge cases', () => {
    it('should handle empty content', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: '' }],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(false)
    })

    it('should handle multimodal content (content blocks)', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'ping' }
            ]
          }
        ],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(service.detectPing(request)).toBe(true)
    })

    it('should handle malformed messages gracefully', () => {
      const request: any = {
        model: 'gpt-4',
        messages: [null],
        stream: true,
        temperature: 0,
        max_tokens: 1
      }

      expect(() => service.detectPing(request)).not.toThrow()
      expect(service.detectPing(request)).toBe(false)
    })
  })
})
