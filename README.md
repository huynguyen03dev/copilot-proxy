# Copilot Proxy

> **⚠️ EDUCATIONAL PURPOSE ONLY**
> This project is for educational and learning purposes only. It demonstrates API proxy patterns, authentication flows, and performance optimization techniques. Not intended for production use.

A command-line tool that exposes GitHub Copilot as an OpenAI-compatible API endpoint for educational exploration of API integration patterns.

## ✨ Features

- **OpenAI-Compatible API** - Educational example of API compatibility layers
- **GitHub OAuth Flow** - Learn device flow authentication patterns
- **Client Compatibility** - Role normalization for Cline, Continue.dev, and other AI clients
- **Performance Optimizations** - Connection pooling, caching, compression
- **CLI Tool** - Easy installation and usage via npm
- **Cross-Platform** - Works on Windows, macOS, and Linux

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Active GitHub Copilot subscription
- Basic understanding of APIs and authentication

### Installation
```bash
# Install globally via npm
npm install -g @hazeruno/copilot-proxy

# Or install locally
npm install @hazeruno/copilot-proxy
```

### Usage
```bash
# Authenticate and start in one command
copilot-proxy --auto-auth

# Or step by step
copilot-proxy --auth        # Authenticate with GitHub
copilot-proxy               # Start the server

# Custom port/host
copilot-proxy --port=3000 --host=localhost
```

Server runs on `http://127.0.0.1:8069` by default.

## 📚 Learning Objectives

This project demonstrates:
- **API Proxy Patterns** - How to create compatibility layers between different APIs
- **OAuth Device Flow** - Modern authentication for CLI/desktop applications
- **Performance Optimization** - Connection pooling, response compression, and intelligent caching
- **Fault Tolerance** - Circuit breaker patterns, retries, and graceful error handling
- **TypeScript Best Practices** - Clean architecture, type safety, and structured logging
- **HTTP Optimization** - Keep-alive connections, response caching, and compression
- **Memory Management** - Efficient token caching and connection pooling

## 🔧 Usage Examples

### Basic API Call
```bash
curl -X POST http://127.0.0.1:8069/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### With Python
```python
import openai
client = openai.OpenAI(
    api_key="dummy-key",
    base_url="http://127.0.0.1:8069/v1"
)
response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello from Python!"}]
)
```

### With JavaScript/Node.js
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'dummy-key',
  baseURL: 'http://127.0.0.1:8069/v1'
});

const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello from Node.js!' }]
});
```

## 📚 Programmatic Usage

You can also use copilot-proxy as a library in your Node.js applications:

```javascript
import { CopilotAPIServer, GitHubCopilotAuth } from '@hazeruno/copilot-proxy';

// Check authentication status
const isAuthenticated = await GitHubCopilotAuth.isAuthenticated();

// Start server programmatically
const server = new CopilotAPIServer(8069, '127.0.0.1');
await server.start();
```

## ⚙️ Configuration

Configure via environment variables or command line arguments:

### Command Line Arguments
```bash
# Default: binds to localhost only (127.0.0.1)
copilot-proxy

# Override port
copilot-proxy --port=8080

# Allow network access (bind to all interfaces)
copilot-proxy --host=0.0.0.0

# Combine options
copilot-proxy --port=8080 --host=0.0.0.0
```

**Note:** The server always defaults to `127.0.0.1` (localhost only) for security. To allow access from other machines on your network, explicitly use `--host=0.0.0.0`.

### Environment Variables
```bash
PORT=8069                          # Server port
LOG_LEVEL=info                     # debug, info, warn, error
ENABLE_COMPRESSION=true            # Response compression (recommended)
CACHE_HEADERS=true                 # Client-side caching (recommended)
ENABLE_CONNECTION_POOLING=true     # HTTP connection pooling (recommended)
```

### Help
```bash
copilot-proxy --help        # Show all available options
```

## 🔍 Key API Endpoints

- `POST /v1/chat/completions` - Main chat endpoint (OpenAI-compatible)
- `GET /v1/models` - List available models
- `GET /auth/status` - Check authentication status
- `GET /` - Health check and server info
- `GET /metrics` - Performance metrics and monitoring data

## 📦 Publishing to npm

To publish this package to npm:

```bash
# Build the project
npm run build

# Publish to npm (requires npm account)
npm publish
```

## 🛠️ Development

If you want to contribute or modify the code:

```bash
# Clone the repository
git clone <repository>
cd copilot-proxy

# Install dependencies
npm install

# Development with auto-reload
npm run dev

# Build the project
npm run build

# Type checking
npm run type-check

# Run tests
npm test
```

## 🔒 Security & Disclaimers

**Educational Use Only:**
- This project demonstrates best-practice API server architecture
- Learn connection pooling, caching, compression, and fault tolerance patterns
- Not intended for production deployment or commercial use
- Showcases TypeScript, performance optimization, and structured logging

**Security Notes:**
- Tokens stored locally in system config directory (restricted permissions)
- Server binds to 127.0.0.1 by default for security
- Uses GitHub's internal API endpoints (subject to change)

**Compliance:**
- Ensure compliance with GitHub's Terms of Service
- Requires active GitHub Copilot subscription
- Use responsibly and respect rate limits

## 🚨 Troubleshooting

**Authentication Issues:**
```bash
# Clear and re-authenticate
copilot-proxy --clear-auth
copilot-proxy --auth
```

**Common Problems:**
- **"Not authenticated"** → Run `copilot-proxy --auth`
- **"Connection refused"** → Check if server is running
- **"Token expired"** → Server auto-refreshes, or re-authenticate
- **"Command not found"** → Install globally with `npm install -g @hazeruno/copilot-proxy`

## 📄 License

MIT License - Educational use encouraged.

---

**⚠️ Important:** This project uses GitHub's internal Copilot API endpoints for educational purposes. These endpoints are not officially documented and may change. Always ensure compliance with GitHub's Terms of Service.
