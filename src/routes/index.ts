import { Hono } from "hono"
import { createHealthRoutes, ServerInfo } from "./health.routes.js"
import { createAuthRoutes } from "./auth.routes.js"
import { createChatRoutes, ChatHandlers } from "./chat.routes.js"
import { createModelsRoutes } from "./models.routes.js"

/**
 * Route aggregator
 * Combines all route modules and sets them up on the main Hono app
 */

export interface RouteServices {
  serverInfo: ServerInfo
  chatHandlers: ChatHandlers
}

/**
 * Setup all routes on the Hono app
 * @param app - The main Hono application instance
 * @param services - Service dependencies required by routes
 */
export function setupRoutes(app: Hono, services: RouteServices): void {
  // Health and metrics routes (/, /metrics, /pool/metrics)
  const healthRoutes = createHealthRoutes(services.serverInfo)
  app.route("/", healthRoutes)

  // Authentication routes (/auth/*)
  const authRoutes = createAuthRoutes()
  app.route("/auth", authRoutes)

  // Chat completions routes (/v1/chat/completions)
  const chatRoutes = createChatRoutes(services.chatHandlers)
  app.route("/v1", chatRoutes)

  // Models routes (/v1/models)
  const modelsRoutes = createModelsRoutes()
  app.route("/v1", modelsRoutes)
}
