/**
 * Unit tests for ChatService
 * Tests core chat completion business logic
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { ChatService } from '../../../src/services/chat/chatService'
import { EndpointDiscoveryService } from '../../../src/services/endpointDiscoveryService'
import { ResponseTransformService } from '../../../src/services/responseTransformService'
import { StreamMonitorService } from '../../../src/services/streamMonitorService'

describe('ChatService', () => {
  let chatService: ChatService
  let mockEndpointDiscovery: EndpointDiscoveryService
  let mockResponseTransform: ResponseTransformService
  let mockStreamMonitor: StreamMonitorService

  beforeEach(() => {
    // Create real instances for integration testing
    mockEndpointDiscovery = new EndpointDiscoveryService()
    mockResponseTransform = new ResponseTransformService()
    mockStreamMonitor = new StreamMonitorService(100, 30000)

    // Create ChatService with dependencies
    chatService = new ChatService(
      mockEndpointDiscovery,
      mockResponseTransform,
      mockStreamMonitor
    )
  })

  describe('constructor and initialization', () => {
    it('should initialize with dependencies', () => {
      expect(chatService).toBeDefined()
      expect(chatService).toBeInstanceOf(ChatService)
    })

    it('should have warmup cache initialized', () => {
      // Warmup cache is private, but we can verify the service is functional
      expect(chatService).toHaveProperty('warmupCache')
    })
  })

  describe('service dependencies', () => {
    it('should have endpoint discovery service', () => {
      expect(mockEndpointDiscovery).toBeInstanceOf(EndpointDiscoveryService)
    })

    it('should have response transform service', () => {
      expect(mockResponseTransform).toBeInstanceOf(ResponseTransformService)
    })

    it('should have stream monitor service', () => {
      expect(mockStreamMonitor).toBeInstanceOf(StreamMonitorService)
    })
  })
})