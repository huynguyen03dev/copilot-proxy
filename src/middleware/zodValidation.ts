/**
 * Zod Validation Middleware
 * PERFORMANCE OPTIMIZATION (Phase 5, Issue #9):
 * Moves Zod validation from route handlers to middleware to avoid double-pass validation
 * - Single validation pass in middleware
 * - Validated body passed via context to route handlers
 * - Consistent error handling
 */

import { Context, Next } from "hono"
import { ChatCompletionRequest } from "../types.js"
import { createAPIErrorResponse } from "../types/errors.js"
import { logger } from "../utils/logger.js"

/**
 * Zod validation middleware for chat completions
 * PERFORMANCE: Validates once in middleware, passes validated body to route handler
 */
export function zodValidationMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Only validate POST requests to chat completions endpoint
    if (c.req.method !== 'POST' || !c.req.path.includes('/chat/completions')) {
      await next()
      return
    }

    // Get already-parsed body from requestSize middleware
    const parsedBody = c.get('parsedBody')

    if (!parsedBody) {
      const errorResponse = createAPIErrorResponse(
        "Request body could not be parsed",
        "invalid_request_error",
        "MISSING_PARSED_BODY"
      )
      return c.json(errorResponse, 400)
    }

    // PERFORMANCE: Single Zod validation pass
    const validationResult = ChatCompletionRequest.safeParse(parsedBody)

    if (!validationResult.success) {
      const issues = validationResult.error.issues

      // Log detailed validation errors for debugging (especially role issues)
      issues.forEach(issue => {
        if (issue.path.includes('role')) {
          logger.warn('VALIDATION', `Role validation failed:`, {
            path: issue.path.join('.'),
            message: issue.message,
            expected: 'system | user | assistant',
            code: issue.code
          })
        }
      })

      const errorMessage = issues.map(issue => {
        const pathStr = issue.path.join('.')
        return `${pathStr}: ${issue.message}`
      }).join(', ')

      const errorResponse = createAPIErrorResponse(
        errorMessage,
        "invalid_request_error",
        "VALIDATION_ERROR"
      )
      return c.json(errorResponse, 400)
    }

    // PERFORMANCE: Store validated body in context for route handler
    c.set('validatedBody', validationResult.data)

    await next()
  }
}

/**
 * Get validated body from context
 * Helper function for route handlers to retrieve validated body
 */
export function getValidatedBody(c: Context): any {
  return c.get('validatedBody')
}

