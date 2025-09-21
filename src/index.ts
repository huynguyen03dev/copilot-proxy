#!/usr/bin/env node

import { CopilotAPIServer } from "./server"
import { GitHubCopilotAuth } from "./auth"
import { config, validateConfiguration } from "./config"
import { logger } from "./utils/logger"
import { sharedUtils } from "./utils/sharedUtilities"

// Parse command line arguments
const args = process.argv.slice(2)
const portArg = args.find(arg => arg.startsWith("--port="))
const hostArg = args.find(arg => arg.startsWith("--host="))
const helpArg = args.includes("--help") || args.includes("-h")
const authArg = args.includes("--auth")
const clearAuthArg = args.includes("--clear-auth")
const autoAuthArg = args.includes("--auto-auth")

// Parse port and hostname for use in help text and server startup
// Port priority: command line arg > config > default
const port = portArg
  ? parseInt(portArg.split("=")[1])
  : config.server.port

// Hostname priority: command line arg > config > default
const hostname = hostArg
  ? hostArg.split("=")[1]
  : config.server.hostname

if (helpArg) {
  console.log(`
GitHub Copilot API Server

Usage: copilot-server [options]

Options:
  --port=<number>     Port to listen on (current: ${port}, default: 8069)
  --host=<string>     Hostname to bind to (current: ${hostname}, default: 127.0.0.1)
  --auth              Start interactive authentication flow
  --auto-auth         Automatically authenticate and start server (seamless)
  --clear-auth        Clear stored authentication
  --help, -h          Show this help message

Environment Variables:
  PORT                Server port (current: ${port})
  HOSTNAME            Server hostname (current: ${hostname})

Examples:
  copilot-server                          # Start server with .env settings
  copilot-server --port=8080              # Override port via command line
  PORT=3000 copilot-server                # Override port via environment
  copilot-server --auth                   # Authenticate with GitHub Copilot
  copilot-server --clear-auth             # Clear authentication

API Endpoints:
  GET  /                                  # Health check
  GET  /auth/status                       # Check authentication status
  POST /auth/start                        # Start authentication flow
  POST /auth/poll                         # Poll for authentication completion
  POST /auth/clear                        # Clear authentication
  POST /v1/chat/completions              # OpenAI-compatible chat endpoint
  GET  /v1/models                        # List available models

Authentication Flow:
  1. Run: copilot-server --auth
  2. Visit the provided GitHub URL (opens automatically if possible)
  3. Enter the user code shown in the terminal
  4. Wait for confirmation (up to 15 minutes)
  5. Start the server: copilot-server
  6. Use the API with any OpenAI-compatible client

Troubleshooting Authentication:
  • If authentication fails: copilot-server --clear-auth && copilot-server --auth
  • Check GitHub Copilot subscription is active
  • Ensure stable internet connection
  • Authentication expires after 15 minutes - retry if needed
`)
  process.exit(0)
}

async function handleAuth() {
  try {
    const result = await GitHubCopilotAuth.authenticateWithFlow()

    if (result.success) {
      console.log("\n🎉 Authentication completed successfully!")
      console.log("You can now start the server with: copilot-server")
      process.exit(0)
    } else {
      console.log("\n❌ Authentication failed")
      if (result.error) {
        console.log(`   Error: ${result.error}`)
      }
      if (result.errorDescription) {
        console.log(`   Details: ${result.errorDescription}`)
      }

      // Provide helpful suggestions based on error type
      switch (result.error) {
        case "expired":
          console.log("\n💡 Suggestions:")
          console.log("   • Run the auth command again to get a new code")
          console.log("   • Make sure to complete authentication within the time limit")
          break
        case "access_denied":
          console.log("\n💡 Suggestions:")
          console.log("   • Run the auth command again")
          console.log("   • Make sure to click 'Authorize' on the GitHub page")
          console.log("   • Check that you have a valid GitHub Copilot subscription")
          break
        case "network_error":
          console.log("\n💡 Suggestions:")
          console.log("   • Check your internet connection")
          console.log("   • Verify GitHub is accessible")
          console.log("   • Try again in a few moments")
          break
        default:
          console.log("\n💡 Suggestions:")
          console.log("   • Try running: copilot-server --clear-auth")
          console.log("   • Then run: copilot-server --auth")
          console.log("   • Make sure you have a valid GitHub Copilot subscription")
      }

      process.exit(1)
    }
  } catch (error) {
    console.error("❌ Failed to start authentication:", error)
    console.log("\n💡 Try running: copilot-server --clear-auth && copilot-server --auth")
    process.exit(1)
  }
}

async function handleClearAuth() {
  console.log("🧹 Clearing stored authentication...")
  await GitHubCopilotAuth.clearAuth()
  console.log("✅ Authentication cleared")
  process.exit(0)
}

async function startServer() {
  // Check if authenticated
  try {
    const isAuthenticated = await GitHubCopilotAuth.isAuthenticated()

    if (!isAuthenticated) {
      console.log("⚠️  Not authenticated with GitHub Copilot")
      console.log("\n💡 Quick options:")
      console.log("   • For seamless authentication: copilot-server --auto-auth")
      console.log("   • For manual authentication: copilot-server --auth")
      console.log("\n⚠️  Server will start but API calls will fail without authentication\n")
    } else {
      console.log("✅ Authenticated with GitHub Copilot")
    }
  } catch (error) {
    console.log("⚠️  Authentication check failed:", error)
    console.log("Starting server anyway for testing...")
  }

  // Start the server
  const server = new CopilotAPIServer(port, hostname)
  await server.start()

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n👋 Shutting down server...")
    await server.shutdown()
    process.exit(0)
  })

  process.on("SIGTERM", async () => {
    console.log("\n👋 Shutting down server...")
    await server.shutdown()
    process.exit(0)
  })
}

async function handleAutoAuth() {
  try {
    console.log("🚀 Starting seamless authentication and server startup...")

    // Check if already authenticated
    const isAuthenticated = await GitHubCopilotAuth.isAuthenticated()
    if (isAuthenticated) {
      console.log("✅ Already authenticated with GitHub Copilot")
    } else {
      console.log("🔐 Not authenticated - starting automatic authentication...")
      const result = await GitHubCopilotAuth.authenticateSeamlessly()

      if (!result.success) {
        console.error("❌ Automatic authentication failed:", result.error)
        if (result.errorDescription) {
          console.error("   Details:", result.errorDescription)
        }
        console.log("\n💡 You can try manual authentication with: copilot-server --auth")
        process.exit(1)
      }
    }

    // Start the server
    console.log("🚀 Starting server...")
    await startServer()
  } catch (error) {
    console.error("❌ Failed to start with auto-authentication:", error)
    console.log("\n💡 Try manual authentication: copilot-server --auth")
    process.exit(1)
  }
}

// Main execution
async function main() {
  // Validate configuration before starting
  if (!validateConfiguration()) {
    console.error('❌ Configuration validation failed. Please fix the errors above.')
    process.exit(1)
  }

  if (clearAuthArg) {
    await handleClearAuth()
  } else if (authArg) {
    await handleAuth()
  } else if (autoAuthArg) {
    await handleAutoAuth()
  } else {
    await startServer()
  }
}

main().catch((error) => {
  console.error("💥 Fatal error:", error)
  process.exit(1)
})
