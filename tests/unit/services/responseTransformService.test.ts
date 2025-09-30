/**
 * Unit tests for ResponseTransformService
 * Tests response transformation from Copilot API to OpenAI format
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { ResponseTransformService } from '../../../src/services/responseTransformService'
import { ChatCompletionRequest } from '../../../src/types'

describe('ResponseTransformService', () => {
  let service: ResponseTransformService

  beforeEach(() => {
    service = new ResponseTransformService()
  })

  describe('transformResponse() - non-streaming', () => {
    const mockRequest: ChatCompletionRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }]
    }

    it('should transform standard Copilot response', () => {
      const copilotResponse = {
        id: 'cmpl-123',
        created: 1234567890,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! How can I help you?'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      }

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.id).toBe('cmpl-123')
      expect(result.object).toBe('chat.completion')
      expect(result.created).toBe(1234567890)
      expect(result.model).toBe('gpt-4')
      expect(result.choices).toHaveLength(1)
      expect(result.choices[0].message.role).toBe('assistant')
      expect(result.choices[0].message.content).toBe('Hello! How can I help you?')
      expect(result.choices[0].finish_reason).toBe('stop')
      expect(result.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      })
    })

    it('should generate default values for missing fields', () => {
      const copilotResponse = {
        // Missing id, created, etc.
        choices: [
          {
            message: {
              content: 'Response'
            }
          }
        ]
      }

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.id).toMatch(/^chatcmpl-\d+$/)
      expect(result.created).toBeGreaterThan(0)
      expect(result.model).toBe('gpt-4')
      expect(result.choices[0].finish_reason).toBe('stop')
    })

    it('should handle response with direct content field', () => {
      const copilotResponse = {
        content: 'Direct content response'
      }

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.choices[0].message.content).toBe('Direct content response')
    })

    it('should handle response with message.content format', () => {
      const copilotResponse = {
        message: {
          content: 'Message content response'
        }
      }

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.choices[0].message.content).toBe('Message content response')
    })

    it('should fallback to default content when no content found', () => {
      const copilotResponse = {}

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.choices[0].message.content).toBe('No response from Copilot')
    })

    it('should handle multiple choices', () => {
      const copilotResponse = {
        choices: [
          {
            index: 0,
            message: { content: 'First choice' },
            finish_reason: 'stop'
          },
          {
            index: 1,
            message: { content: 'Second choice' },
            finish_reason: 'length'
          }
        ]
      }

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.choices).toHaveLength(2)
      expect(result.choices[0].message.content).toBe('First choice')
      expect(result.choices[1].message.content).toBe('Second choice')
      expect(result.choices[1].finish_reason).toBe('length')
    })

    it('should handle missing usage field', () => {
      const copilotResponse = {
        choices: [
          {
            message: { content: 'Response' }
          }
        ]
      }

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.usage).toBeUndefined()
    })

    it('should handle partial usage data', () => {
      const copilotResponse = {
        choices: [],
        usage: {
          prompt_tokens: 10
          // Missing completion_tokens and total_tokens
        }
      }

      const result = service.transformResponse(copilotResponse, mockRequest)

      expect(result.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 0,
        total_tokens: 0
      })
    })
  })

  describe('transformStreamChunk() - streaming', () => {
    const mockRequest: ChatCompletionRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }]
    }

    it('should transform standard streaming chunk', () => {
      const copilotChunk = {
        id: 'cmpl-123',
        created: 1234567890,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'Hello'
            },
            finish_reason: null
          }
        ]
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.id).toBe('cmpl-123')
      expect(result.object).toBe('chat.completion.chunk')
      expect(result.created).toBe(1234567890)
      expect(result.model).toBe('gpt-4')
      expect(result.choices).toHaveLength(1)
      expect(result.choices[0].delta.role).toBe('assistant')
      expect(result.choices[0].delta.content).toBe('Hello')
      expect(result.choices[0].finish_reason).toBeNull()
    })

    it('should handle chunk with only content delta', () => {
      const copilotChunk = {
        choices: [
          {
            delta: {
              content: ' world'
            }
          }
        ]
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.choices[0].delta.content).toBe(' world')
      expect(result.choices[0].delta.role).toBeUndefined()
    })

    it('should handle final chunk with finish_reason', () => {
      const copilotChunk = {
        choices: [
          {
            delta: {},
            finish_reason: 'stop'
          }
        ]
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.choices[0].finish_reason).toBe('stop')
    })

    it('should validate role values', () => {
      const copilotChunk = {
        choices: [
          {
            delta: {
              role: 'invalid_role', // Invalid role
              content: 'test'
            }
          }
        ]
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.choices[0].delta.role).toBeUndefined() // Invalid role filtered out
      expect(result.choices[0].delta.content).toBe('test')
    })

    it('should accept valid roles', () => {
      const roles = ['system', 'user', 'assistant'] as const

      roles.forEach(role => {
        const copilotChunk = {
          choices: [
            {
              delta: {
                role,
                content: 'test'
              }
            }
          ]
        }

        const result = service.transformStreamChunk(copilotChunk, mockRequest)

        expect(result.choices[0].delta.role).toBe(role)
      })
    })

    it('should handle empty choices array', () => {
      const copilotChunk = {
        choices: []
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.choices).toHaveLength(1) // Default choice added
      expect(result.choices[0].delta.content).toBe('')
    })

    it('should handle direct content field fallback', () => {
      const copilotChunk = {
        content: 'Direct content chunk',
        choices: []
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.choices[0].delta.content).toBe('Direct content chunk')
    })

    it('should preserve choice index', () => {
      const copilotChunk = {
        choices: [
          {
            index: 5,
            delta: { content: 'test' }
          }
        ]
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.choices[0].index).toBe(5)
    })

    it('should generate default index if missing', () => {
      const copilotChunk = {
        choices: [
          { delta: { content: 'first' } },
          { delta: { content: 'second' } }
        ]
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.choices[0].index).toBe(0)
      expect(result.choices[1].index).toBe(1)
    })

    it('should handle usage in streaming chunk', () => {
      const copilotChunk = {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 10,
          total_tokens: 15
        }
      }

      const result = service.transformStreamChunk(copilotChunk, mockRequest)

      expect(result.usage).toEqual({
        prompt_tokens: 5,
        completion_tokens: 10,
        total_tokens: 15
      })
    })
  })

  describe('validateResponse()', () => {
    it('should validate correct response', () => {
      const response = {
        choices: [
          { message: { content: 'test' } }
        ]
      }

      expect(service.validateResponse(response)).toBe(true)
    })

    it('should validate response with content field', () => {
      const response = {
        content: 'Direct content'
      }

      expect(service.validateResponse(response)).toBe(true)
    })

    it('should reject null response', () => {
      expect(service.validateResponse(null)).toBe(false)
    })

    it('should reject non-object response', () => {
      expect(service.validateResponse('string')).toBe(false)
      expect(service.validateResponse(123)).toBe(false)
      expect(service.validateResponse(true)).toBe(false)
    })

    it('should reject response without choices or content', () => {
      const response = {
        id: 'cmpl-123',
        created: 123456
      }

      expect(service.validateResponse(response)).toBe(false)
    })
  })

  describe('validateStreamChunk()', () => {
    it('should validate correct chunk', () => {
      const chunk = {
        choices: [
          { delta: { content: 'test' } }
        ]
      }

      expect(service.validateStreamChunk(chunk)).toBe(true)
    })

    it('should reject chunk without choices', () => {
      const chunk = {
        content: 'test'
      }

      expect(service.validateStreamChunk(chunk)).toBe(false)
    })

    it('should reject null chunk', () => {
      expect(service.validateStreamChunk(null)).toBe(false)
    })

    it('should reject non-object chunk', () => {
      expect(service.validateStreamChunk('string')).toBe(false)
    })
  })

  describe('edge cases', () => {
    const mockRequest: ChatCompletionRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test' }]
    }

    it('should handle deeply nested structures', () => {
      const response = {
        choices: [
          {
            message: {
              content: 'test'
            }
          }
        ]
      }

      expect(() => service.transformResponse(response, mockRequest)).not.toThrow()
    })

    it('should handle undefined values gracefully', () => {
      const response = {
        id: undefined,
        created: undefined,
        choices: undefined
      }

      const result = service.transformResponse(response, mockRequest)

      expect(result).toBeDefined()
      expect(result.id).toMatch(/^chatcmpl-/)
    })

    it('should handle malformed choices array', () => {
      const response = {
        choices: [null, undefined, {}]
      }

      expect(() => service.transformResponse(response, mockRequest)).not.toThrow()
    })
  })
})
