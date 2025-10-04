import { Hono } from "hono"
import { GitHubCopilotAuth } from "../auth.js"
import { createAPIErrorResponse } from "../types/errors.js"

/**
 * Models route handlers
 * Provides endpoint for listing available models
 */

/**
 * Available models for GitHub Copilot
 */
const AVAILABLE_MODELS = [
  {
    id: "gpt-4o",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "gpt-4.1",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "claude-sonnet-4",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "gemini-2.0-flash-001",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "gpt-5-mini",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "gpt-5",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "o4-mini",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "o3-mini",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "gemini-2.5-pro",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
  {
    id: "grok-code-fast-1",
    object: "model",
    created: Date.now(),
    owned_by: "github-copilot"
  },
]

/**
 * Create models routes
 */
export function createModelsRoutes(): Hono {
  const app = new Hono()

  /**
   * GET /v1/models - List available models
   * Returns a list of available models (requires authentication)
   */
  app.get("/models", async (c) => {
    const isAuthenticated = await GitHubCopilotAuth.isAuthenticated()

    if (!isAuthenticated) {
      const errorResponse = createAPIErrorResponse(
        "Not authenticated",
        "authentication_error",
        "UNAUTHENTICATED"
      )
      return c.json(errorResponse, 401)
    }

    return c.json({
      object: "list",
      data: AVAILABLE_MODELS
    })
  })

  return app
}
