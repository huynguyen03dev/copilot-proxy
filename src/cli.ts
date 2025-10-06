#!/usr/bin/env node

import { CopilotAPIServer } from "./server.js"
import { GitHubCopilotAuth } from "./auth.js"
import { config, validateConfiguration } from "./config/index.js"

// Parse command line arguments
const args = process.argv.slice(2)
const portArg = args.find(arg => arg.startsWith("--port="))
const hostArg = args.find(arg => arg.startsWith("--host="))
const helpArg = args.includes("--help") || args.includes("-h")
const authArg = args.includes("--auth")
const clearAuthArg = args.includes("--clear-auth")

// Parse port and hostname for use in help text and server startup
const port = portArg ? parseInt(portArg.split("=")[1]) : config.server.port
const hostname = hostArg ? hostArg.split("=")[1] : "127.0.0.1" // Always default to localhost unless --host is provided

function printHelp() {
  console.log(`
Copilot Proxy (Node)

Usage: copilot-proxy [options]

⚠️  AUTHENTICATION: Server automatically authenticates with GitHub Copilot on startup.

Options:
  --port=<number>     Port to listen on (current: ${port}, default: 8069)
  --host=<string>     Hostname to bind to (current: ${hostname}, default: 127.0.0.1)
                      Use --host=0.0.0.0 to allow network access
  --auth              Start interactive authentication flow only (no server)
  --clear-auth        Clear stored authentication
  --help, -h          Show this help message

Environment Variables:
  PORT                Server port (current: ${port})

Examples:
  copilot-proxy                         # Start server with automatic authentication (default)
  copilot-proxy --port=8080             # Override port via command line
  copilot-proxy --host=0.0.0.0          # Allow network access (bind to all interfaces)
  PORT=3000 copilot-proxy               # Override port via environment
  copilot-proxy --auth                  # Manual authentication only (no server start)
  copilot-proxy --clear-auth            # Clear authentication

API Endpoints:
  GET  /                                  # Health check
  GET  /auth/status                       # Check authentication status
  POST /auth/start                        # Start authentication flow
  POST /auth/poll                         # Poll for authentication completion
  POST /auth/clear                        # Clear authentication
  POST /v1/chat/completions               # OpenAI-compatible chat endpoint
  GET  /v1/models                         # List available models

Authentication Flow:
  By default, the server automatically authenticates on startup.

  Manual authentication (optional):
  1. Run: copilot-proxy --auth
  2. Visit the provided GitHub URL (opens automatically if possible)
  3. Enter the user code shown in the terminal
  4. Wait for confirmation (up to 15 minutes)
  5. Authentication is saved for future use

Troubleshooting Authentication:
  • If authentication fails: copilot-proxy --clear-auth
  • Check GitHub Copilot subscription is active
  • Ensure stable internet connection
  • Authentication expires after 15 minutes - retry if needed
`)
}

async function handleAuth() {
  try {
    const result = await GitHubCopilotAuth.authenticateWithFlow()

    if (result.success) {
      console.log("\n🎉 Authentication completed successfully!")
      console.log("You can now start the server with: copilot-proxy")
      process.exit(0)
    } else {
      console.log("\n❌ Authentication failed")
      if (result.error) {
        console.log(`   Error: ${result.error}`)
      }
      if (result.errorDescription) {
        console.log(`   Details: ${result.errorDescription}`)
      }

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
          console.log("   • Try running: copilot-proxy --clear-auth")
          console.log("   • Then run: copilot-proxy --auth")
          console.log("   • Make sure you have a valid GitHub Copilot subscription")
      }

      process.exit(1)
    }
  } catch (error) {
    console.error("❌ Failed to start authentication:", error)
    console.log("\n💡 Try running: copilot-proxy --clear-auth && copilot-proxy --auth")
    process.exit(1)
  }
}

async function handleClearAuth() {
  console.log("🧹 Clearing stored authentication...")
  await GitHubCopilotAuth.clearAuth()
  console.log("✅ Authentication cleared")
  process.exit(0)
}

async function startServerWithAuth() {
  try {
    console.log("🚀 Starting Copilot Proxy with automatic authentication...")

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
        console.log("\n💡 You can try manual authentication with: copilot-proxy --auth")
        process.exit(1)
      }
    }

    console.log("🚀 Starting server...")
    const server = new CopilotAPIServer(port, hostname)
    await server.start()

    process.on("SIGINT", () => {
      console.log("\n👋 Shutting down server...")
      process.exit(0)
    })

    process.on("SIGTERM", () => {
      console.log("\n👋 Shutting down server...")
      process.exit(0)
    })
  } catch (error) {
    console.error("❌ Failed to start server:", error)
    console.log("\n💡 Try manual authentication: copilot-proxy --auth")
    process.exit(1)
  }
}

async function main() {
  if (helpArg) {
    printHelp()
    process.exit(0)
  }

  if (!validateConfiguration()) {
    console.error('❌ Configuration validation failed. Please fix the errors above.')
    process.exit(1)
  }

  if (clearAuthArg) {
    await handleClearAuth()
  } else if (authArg) {
    await handleAuth()
  } else {
    // Default behavior: start server with automatic authentication
    await startServerWithAuth()
  }
}

main().catch((error) => {
  console.error("💥 Fatal error:", error)
  process.exit(1)
})

