import { z } from "zod"

/**
 * Anthropic Claude API Types
 * Based on the Anthropic Messages API format
 * https://docs.anthropic.com/claude/reference/messages_post
 */

// Content block types for Anthropic format
export const AnthropicTextContent = z.object({
  type: z.literal("text"),
  text: z.string().min(1, "Text content cannot be empty"),
})

export const AnthropicImageContent = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string(),
  }).or(z.object({
    type: z.literal("url"),
    url: z.string(),
  })),
})

export const AnthropicContentBlock = z.union([AnthropicTextContent, AnthropicImageContent])

// Message format for Anthropic
export const AnthropicMessage = z.object({
  role: z.enum(["user", "assistant"], {
    errorMap: (issue, ctx) => {
      return {
        message: `Role must be either "user" or "assistant" (received: "${ctx.data}")`
      }
    }
  }),
  content: z.union([
    z.string().min(1, "Content cannot be empty"),
    z.array(AnthropicContentBlock).min(1, "Content array cannot be empty")
  ]),
})

// Request schema for Anthropic Messages API
export const AnthropicMessagesRequest = z.object({
  model: z.string().min(1, "Model is required and cannot be empty"),
  messages: z.array(AnthropicMessage).min(1, "Messages array cannot be empty"),
  max_tokens: z.number().min(1, "Max tokens must be >= 1").max(100000, "Max tokens must be <= 100000"),
  system: z.union([
    z.string(),
    z.array(AnthropicTextContent)  // System supports array of text blocks
  ]).optional(),
  temperature: z.number().min(0, "Temperature must be >= 0").max(2, "Temperature must be <= 2").optional(),
  stream: z.boolean().optional(),
  top_p: z.number().min(0, "Top-p must be >= 0").max(1, "Top-p must be <= 1").optional(),
  top_k: z.number().min(1, "Top-k must be >= 1").optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.object({
    user_id: z.string().optional(),
  }).optional(),
})

// Response content block types
export const AnthropicResponseTextContent = z.object({
  type: z.literal("text"),
  text: z.string(),
})

// Response schema for Anthropic Messages API
export const AnthropicMessagesResponse = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(AnthropicResponseTextContent),
  model: z.string(),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
})

// Streaming event types for Anthropic
export const AnthropicStreamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_start"),
    message: z.object({
      id: z.string(),
      type: z.literal("message"),
      role: z.literal("assistant"),
      content: z.array(z.any()),
      model: z.string(),
      stop_reason: z.null(),
      stop_sequence: z.null(),
      usage: z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
      }),
    }),
  }),
  z.object({
    type: z.literal("content_block_start"),
    index: z.number(),
    content_block: z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index: z.number(),
    delta: z.object({
      type: z.literal("text_delta"),
      text: z.string(),
    }),
  }),
  z.object({
    type: z.literal("content_block_stop"),
    index: z.number(),
  }),
  z.object({
    type: z.literal("message_delta"),
    delta: z.object({
      stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).nullable(),
      stop_sequence: z.string().nullable().optional(),
    }),
    usage: z.object({
      output_tokens: z.number(),
    }),
  }),
  z.object({
    type: z.literal("message_stop"),
  }),
  z.object({
    type: z.literal("ping"),
  }),
])

// Type exports
export type AnthropicTextContent = z.infer<typeof AnthropicTextContent>
export type AnthropicImageContent = z.infer<typeof AnthropicImageContent>
export type AnthropicContentBlock = z.infer<typeof AnthropicContentBlock>
export type AnthropicMessage = z.infer<typeof AnthropicMessage>
export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequest>
export type AnthropicMessagesResponse = z.infer<typeof AnthropicMessagesResponse>
export type AnthropicResponseTextContent = z.infer<typeof AnthropicResponseTextContent>
export type AnthropicStreamEvent = z.infer<typeof AnthropicStreamEvent>

