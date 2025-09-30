import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamChunk
} from '../types.js'

/**
 * Service for transforming Copilot API responses to OpenAI-compatible format
 * 
 * Handles:
 * - Non-streaming response transformation
 * - Streaming chunk transformation
 * - Various response formats from Copilot API
 * - Safe property access with type guards
 */
export class ResponseTransformService {
  /**
   * Transform non-streaming Copilot response to OpenAI format
   */
  transformResponse(
    copilotResponse: unknown,
    request: ChatCompletionRequest
  ): ChatCompletionResponse {
    // Type guard and safe property access
    const response = copilotResponse as Record<string, unknown>
    const responseId = typeof response?.id === 'string' ? response.id : `chatcmpl-${Date.now()}`
    const responseCreated = typeof response?.created === 'number' ? response.created : Math.floor(Date.now() / 1000)
    const responseChoices = Array.isArray(response?.choices) ? response.choices : []
    const responseUsage = response?.usage && typeof response.usage === 'object' ? response.usage as Record<string, unknown> : undefined
    
    // Extract content from various possible response formats
    let content = "No response from Copilot"
    if (typeof response?.content === 'string') {
      content = response.content
    } else if (response?.message && typeof response.message === 'object') {
      const message = response.message as Record<string, unknown>
      if (typeof message?.content === 'string') {
        content = message.content
      }
    } else if (responseChoices.length > 0) {
      const firstChoice = responseChoices[0] as Record<string, unknown>
      if (firstChoice?.message && typeof firstChoice.message === 'object') {
        const message = firstChoice.message as Record<string, unknown>
        if (typeof message?.content === 'string') {
          content = message.content
        }
      }
    }
    
    // Transform response to OpenAI format
    const openAIResponse: ChatCompletionResponse = {
      id: responseId,
      object: "chat.completion",
      created: responseCreated,
      model: request.model,
      choices: responseChoices.length > 0 ? responseChoices.map((choice, index) => {
        const choiceObj = choice as Record<string, unknown>
        return {
          index,
          message: {
            role: "assistant",
            content: typeof choiceObj?.message === 'object' && choiceObj.message !== null
              ? (choiceObj.message as Record<string, unknown>)?.content as string || content
              : content
          },
          finish_reason: typeof choiceObj?.finish_reason === 'string' ? choiceObj.finish_reason : "stop"
        }
      }) : [{
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }],
      usage: responseUsage ? {
        prompt_tokens: typeof responseUsage.prompt_tokens === 'number' ? responseUsage.prompt_tokens : 0,
        completion_tokens: typeof responseUsage.completion_tokens === 'number' ? responseUsage.completion_tokens : 0,
        total_tokens: typeof responseUsage.total_tokens === 'number' ? responseUsage.total_tokens : 0
      } : undefined
    }
    
    return openAIResponse
  }
  
  /**
   * Transform streaming Copilot chunk to OpenAI format
   */
  transformStreamChunk(
    copilotChunk: unknown,
    request: ChatCompletionRequest
  ): ChatCompletionStreamChunk {
    // Type guard and safe property access
    const chunk = copilotChunk as Record<string, unknown>
    const chunkId = typeof chunk?.id === 'string' ? chunk.id : `chatcmpl-${Date.now()}`
    const chunkCreated = typeof chunk?.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000)
    const chunkChoices = Array.isArray(chunk?.choices) ? chunk.choices : []
    const chunkUsage = chunk?.usage && typeof chunk.usage === 'object' ? chunk.usage as Record<string, unknown> : undefined
    
    return {
      id: chunkId,
      object: "chat.completion.chunk",
      created: chunkCreated,
      model: request.model,
      choices: chunkChoices.length > 0 ? chunkChoices.map((choice, index) => {
        const choiceObj = choice as Record<string, unknown>
        const delta = choiceObj?.delta as Record<string, unknown> | undefined
        
        // Validate role is one of the allowed values
        const roleValue = typeof delta?.role === 'string' ? delta.role : undefined
        const validRole = roleValue === 'system' || roleValue === 'user' || roleValue === 'assistant' ? roleValue : undefined
        
        return {
          index: typeof choiceObj?.index === 'number' ? choiceObj.index : index,
          delta: {
            role: validRole,
            content: typeof delta?.content === 'string' ? delta.content : undefined,
          },
          finish_reason: typeof choiceObj?.finish_reason === 'string' ? choiceObj.finish_reason : null,
        }
      }) : [{
        index: 0,
        delta: {
          content: typeof chunk?.content === 'string' ? chunk.content : "",
        },
        finish_reason: null,
      }],
      usage: chunkUsage ? {
        prompt_tokens: typeof chunkUsage.prompt_tokens === 'number' ? chunkUsage.prompt_tokens : 0,
        completion_tokens: typeof chunkUsage.completion_tokens === 'number' ? chunkUsage.completion_tokens : 0,
        total_tokens: typeof chunkUsage.total_tokens === 'number' ? chunkUsage.total_tokens : 0
      } : undefined,
    }
  }
  
  /**
   * Validate response format
   */
  validateResponse(response: unknown): boolean {
    if (!response || typeof response !== 'object') {
      return false
    }
    
    const obj = response as Record<string, unknown>
    
    // Must have either choices array or content
    if (!Array.isArray(obj.choices) && typeof obj.content !== 'string') {
      return false
    }
    
    return true
  }
  
  /**
   * Validate stream chunk format
   */
  validateStreamChunk(chunk: unknown): boolean {
    if (!chunk || typeof chunk !== 'object') {
      return false
    }
    
    const obj = chunk as Record<string, unknown>
    
    // Must have choices array
    if (!Array.isArray(obj.choices)) {
      return false
    }
    
    return true
  }
}

/**
 * Singleton instance for convenience
 */
export const responseTransformService = new ResponseTransformService()
