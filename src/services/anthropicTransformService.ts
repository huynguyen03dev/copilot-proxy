import { logger } from '../utils/logger.js'
import {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicResponseTextContent,
} from '../types/anthropic.js'
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentBlock,
} from '../types.js'

/**
 * Service for transforming requests/responses between Anthropic and OpenAI formats
 * 
 * This allows the proxy to accept Anthropic-formatted requests (e.g., from droid CLI)
 * and translate them to OpenAI format for GitHub Copilot compatibility.
 */
export class AnthropicTransformService {
  /**
   * Transform Anthropic Messages API request to OpenAI Chat Completions format
   */
  transformAnthropicToOpenAI(request: AnthropicMessagesRequest): ChatCompletionRequest {
    logger.debug('ANTHROPIC_TRANSFORM', 'Transforming Anthropic request to OpenAI format')

    const messages: ChatMessage[] = []

    // Add system message if present
    if (request.system) {
      if (typeof request.system === 'string') {
        messages.push({
          role: 'system',
          content: request.system,
        })
      } else {
        // Array of text blocks - concatenate them
        const systemText = request.system.map(block => block.text).join('\n')
        messages.push({
          role: 'system',
          content: systemText,
        })
      }
    }

    // Transform messages
    for (const msg of request.messages) {
      messages.push(this.transformAnthropicMessage(msg))
    }

    // Build OpenAI request
    const openAIRequest: ChatCompletionRequest = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens,
      stream: request.stream,
    }

    // Add optional parameters
    if (request.temperature !== undefined) {
      openAIRequest.temperature = request.temperature
    }
    if (request.top_p !== undefined) {
      openAIRequest.top_p = request.top_p
    }
    if (request.stop_sequences !== undefined && request.stop_sequences.length > 0) {
      openAIRequest.stop = request.stop_sequences
    }

    logger.debug('ANTHROPIC_TRANSFORM', `Transformed ${request.messages.length} messages (+ ${request.system ? '1 system' : '0 system'})`)
    
    return openAIRequest
  }

  /**
   * Transform a single Anthropic message to OpenAI format
   */
  private transformAnthropicMessage(message: AnthropicMessage): ChatMessage {
    // Handle string content
    if (typeof message.content === 'string') {
      return {
        role: message.role,
        content: message.content,
      }
    }

    // Handle array content (multimodal)
    const contentBlocks: ContentBlock[] = []
    
    for (const block of message.content) {
      if (block.type === 'text') {
        contentBlocks.push({
          type: 'text',
          text: block.text,
        })
      } else if (block.type === 'image') {
        // Transform Anthropic image format to OpenAI image_url format
        let imageUrl: string
        
        if (block.source.type === 'base64') {
          // Convert base64 source to data URL
          imageUrl = `data:${block.source.media_type};base64,${block.source.data}`
        } else {
          // URL source
          imageUrl = block.source.url
        }
        
        contentBlocks.push({
          type: 'image_url',
          image_url: {
            url: imageUrl,
          },
        })
      }
    }

    return {
      role: message.role,
      content: contentBlocks,
    }
  }

  /**
   * Transform OpenAI Chat Completions response to Anthropic Messages format
   */
  transformOpenAIToAnthropic(
    response: ChatCompletionResponse,
    requestId?: string
  ): AnthropicMessagesResponse {
    logger.debug('ANTHROPIC_TRANSFORM', 'Transforming OpenAI response to Anthropic format')

    // Extract the assistant message from the first choice
    const choice = response.choices[0]
    if (!choice) {
      throw new Error('No choices in OpenAI response')
    }

    const message = choice.message
    
    // Convert content to Anthropic format (always array of text blocks)
    const content: AnthropicResponseTextContent[] = []
    
    if (typeof message.content === 'string') {
      content.push({
        type: 'text',
        text: message.content,
      })
    } else if (Array.isArray(message.content)) {
      // Extract text from content blocks
      for (const block of message.content) {
        if (block.type === 'text') {
          content.push({
            type: 'text',
            text: block.text,
          })
        }
      }
    }

    // Map finish_reason to stop_reason
    const stopReason = this.mapFinishReasonToStopReason(choice.finish_reason)

    // Build Anthropic response
    const anthropicResponse: AnthropicMessagesResponse = {
      id: requestId || response.id,
      type: 'message',
      role: 'assistant',
      content,
      model: response.model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: response.usage?.prompt_tokens || 0,
        output_tokens: response.usage?.completion_tokens || 0,
      },
    }

    return anthropicResponse
  }

  /**
   * Map OpenAI finish_reason to Anthropic stop_reason
   */
  private mapFinishReasonToStopReason(
    finishReason: string
  ): "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null {
    switch (finishReason) {
      case 'stop':
        return 'end_turn'
      case 'length':
        return 'max_tokens'
      case 'content_filter':
        return 'end_turn'
      case 'tool_calls':
        return 'tool_use'
      default:
        logger.warn('ANTHROPIC_TRANSFORM', `Unknown finish_reason: ${finishReason}, using end_turn`)
        return 'end_turn'
    }
  }

  /**
   * Transform OpenAI streaming chunk to Anthropic streaming event format
   * Returns the event type and data for SSE
   */
  transformStreamChunkToAnthropicEvent(
    chunk: any,
    isFirst: boolean,
    isLast: boolean,
    messageId: string,
    model: string
  ): { event: string; data: string }[] {
    const events: { event: string; data: string }[] = []

    // First chunk: send message_start and content_block_start
    if (isFirst) {
      events.push({
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        }),
      })

      events.push({
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'text',
            text: '',
          },
        }),
      })
    }

    // Extract delta content
    const delta = chunk.choices?.[0]?.delta
    if (delta?.content) {
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: delta.content,
          },
        }),
      })
    }

    // Last chunk: send content_block_stop, message_delta, and message_stop
    if (isLast) {
      const finishReason = chunk.choices?.[0]?.finish_reason
      
      events.push({
        event: 'content_block_stop',
        data: JSON.stringify({
          type: 'content_block_stop',
          index: 0,
        }),
      })

      events.push({
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: {
            stop_reason: finishReason ? this.mapFinishReasonToStopReason(finishReason) : 'end_turn',
            stop_sequence: null,
          },
          usage: {
            output_tokens: chunk.usage?.completion_tokens || 0,
          },
        }),
      })

      events.push({
        event: 'message_stop',
        data: JSON.stringify({
          type: 'message_stop',
        }),
      })
    }

    return events
  }
}

/**
 * Singleton instance
 */
export const anthropicTransformService = new AnthropicTransformService()

