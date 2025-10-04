import { Hono } from "hono"
import { GitHubCopilotAuth } from "../auth.js"
import { createAPIErrorResponse } from "../types/errors.js"

/**
 * Authentication route handlers
 * Provides endpoints for GitHub Copilot authentication flow
 */

/**
 * Create authentication routes
 */
export function createAuthRoutes(): Hono {
  const app = new Hono()

  /**
   * GET /auth/status - Check authentication status
   * Returns whether the user is currently authenticated
   */
  app.get("/status", async (c) => {
    const isAuthenticated = await GitHubCopilotAuth.isAuthenticated()
    return c.json({ authenticated: isAuthenticated })
  })

  /**
   * POST /auth/start - Start authentication flow
   * Initiates the device code authentication flow
   */
  app.post("/start", async (c) => {
    try {
      const authData = await GitHubCopilotAuth.authorize()
      return c.json({
        device_code: authData.device,
        user_code: authData.user,
        verification_uri: authData.verification,
        interval: authData.interval,
        expires_in: authData.expiry,
        message: `Please visit ${authData.verification} and enter code: ${authData.user}`
      })
    } catch (error) {
      const errorResponse = createAPIErrorResponse(
        error instanceof Error ? error.message : "Authentication failed",
        "auth_error",
        "AUTHENTICATION_FAILED"
      )
      return c.json(errorResponse, 400)
    }
  })

  /**
   * POST /auth/poll - Poll for authentication completion
   * Polls GitHub to check if user has completed authentication
   */
  app.post("/poll", async (c) => {
    const body = await c.req.json()
    const deviceCode = body.device_code

    if (!deviceCode) {
      const errorResponse = createAPIErrorResponse(
        "device_code is required",
        "invalid_request_error",
        "MISSING_DEVICE_CODE",
        "device_code"
      )
      return c.json(errorResponse, 400)
    }

    try {
      const result = await GitHubCopilotAuth.poll(deviceCode)
      return c.json({
        status: result.status,
        error: result.error,
        error_description: result.errorDescription
      })
    } catch (error) {
      const errorResponse = createAPIErrorResponse(
        error instanceof Error ? error.message : "Polling failed",
        "auth_error",
        "POLLING_FAILED"
      )
      return c.json(errorResponse, 400)
    }
  })

  /**
   * POST /auth/clear - Clear authentication
   * Removes stored authentication credentials
   */
  app.post("/clear", async (c) => {
    await GitHubCopilotAuth.clearAuth()
    return c.json({ message: "Authentication cleared" })
  })

  /**
   * POST /auth/complete - Complete authentication flow
   * Alternative to manual polling - completes the full authentication flow
   */
  app.post("/complete", async (c) => {
    try {
      const result = await GitHubCopilotAuth.authenticateWithFlow()

      if (result.success) {
        return c.json({
          success: true,
          message: "Authentication completed successfully"
        })
      } else {
        return c.json({
          success: false,
          error: result.error,
          error_description: result.errorDescription,
          message: "Authentication failed"
        }, 400)
      }
    } catch (error) {
      const errorResponse = createAPIErrorResponse(
        error instanceof Error ? error.message : "Authentication flow failed",
        "auth_error",
        "AUTHENTICATION_FLOW_FAILED"
      )
      return c.json(errorResponse, 500)
    }
  })

  return app
}
