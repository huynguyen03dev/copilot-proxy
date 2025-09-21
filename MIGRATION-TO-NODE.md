# Migration Plan: Move from Bun.serve to @hono/node-server (Node-only CLI)

This document converts the Bun-based TypeScript server to run on pure Node.js using `@hono/node-server`, enabling an npm-installed global CLI without requiring Bun at runtime. It preserves current functionality (Hono server, authentication, streaming, middleware, performance helpers).

---

## 0) Prerequisites & Goals

- Node.js 18+ (global `fetch`, Web Streams, WHATWG URL)
- npm 9+ recommended
- TypeScript 5.x
- End users should only need Node.js (no Bun)

Goals:
- Replace `Bun.serve` with `@hono/node-server`.
- Build with a bundler (`tsup`) and run with Node (fixes Node ESM import resolution for extensionless internal imports).
- Keep CLI flags and flows; keep undici-based networking and streaming; prefer a Node bin wrapper for cross-OS robustness.

---

## 1) Code changes: Replace Bun APIs with Node.js equivalents

- [ ] Add `@hono/node-server`
- [ ] Update server startup from `Bun.serve` → `serve({ fetch: app.fetch, port, hostname })`
- [ ] Keep reference to returned server for graceful shutdown

Before (excerpt, `src/server.ts`):

```ts
// ...
async start(): Promise<void> {
  const server = Bun.serve({
    port: this.port,
    hostname: this.hostname,
    fetch: this.app.fetch,
  })
  this.server = server
  // ...
}
```

After (Node):

```ts
import { serve } from "@hono/node-server"
// ...
async start(): Promise<void> {
  const server = serve({
    fetch: this.app.fetch,
    port: this.port,
    hostname: this.hostname,
  })
  this.server = server
  // ...
}
```

Notes:
- All Hono routes/middleware remain unchanged.
- `@hono/node-server` returns a Node server-like instance; use it for shutdown.


### Graceful shutdown (Node)

Replace Bun's `server.stop()` with Node's `server.close()` and ensure you call shutdown before exiting on signals.

Server change (src/server.ts):

<augment_code_snippet path="src/server.ts" mode="EXCERPT">
````ts
async shutdown(): Promise<void> {
  // Stop accepting new connections and wait for close
  if (this.server && "close" in this.server) {
    await new Promise<void>((res) => this.server!.close(() => res()))
  }
  await connectionPool.close()
  // ... keep existing metrics/logging
}
````
</augment_code_snippet>

Signal handling (src/index.ts):

<augment_code_snippet path="src/index.ts" mode="EXCERPT">
````ts
process.on("SIGINT", async () => {
  await server.shutdown()
  process.exit(0)
})
process.on("SIGTERM", async () => {
  await server.shutdown()
  process.exit(0)
})
````
</augment_code_snippet>

---

## 2) package.json and tsconfig updates

- [ ] Add dependency: `@hono/node-server`
- [ ] Add dev dependency: `@types/node`
- [ ] Remove Bun-specific types: `@types/bun` (and `"types": ["bun-types"]` from tsconfig)
- [ ] Switch build to a bundler (`tsup`) and start to `node dist/index.js`
- [ ] Ensure bin mapping runs with Node

Example `package.json` changes (additions/changes shown only):

```json
{
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "copilot-server": "bin/cli.js" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --sourcemap --dts --out-dir dist --clean",
    "start": "node dist/index.js",
    "dev": "node --watch dist/index.js",
    "prepublishOnly": "npm run build"
  },
  "engines": { "node": ">=18" },
  "dependencies": {
    "@hono/node-server": "^1.12.0",
    "hono": "^4.6.3",
    "undici": "^6.19.8",
    "zod": "^3.23.8",
    "@hono/zod-validator": "^0.2.2"
  },
  "devDependencies": {
    "@types/node": "^20.11.30",
    "typescript": "^5.6.2",
    "tsup": "^8.1.0"
  },
  "files": ["dist", "bin", "README.md", "LICENSE"]
}
```

`tsconfig.json` (key lines):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "strict": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"],
    "lib": ["ES2022", "DOM"]
  }
}
```

---

## 3) CLI entry points for Node execution

Primary recommendation — Node wrapper (most robust across OS/package managers):

- [ ] Create `bin/cli.js` that launches `dist/index.js` with Node
- [ ] Map `bin` to `bin/cli.js` in `package.json`

```js
#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/index.js");
process.exit(
  spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1
);
```

Alternative — Shebang on compiled entry:

- [ ] Change first line of `src/index.ts` to `#!/usr/bin/env node` (tsc preserves shebang)
- [ ] Map `bin` to `dist/index.js` in `package.json`

```ts
#!/usr/bin/env node
// existing CLI code
```

Tip: Update CLI help text in `src/index.ts` to show `copilot-server` instead of `bun run ...` (cosmetic only).

---

## 4) Testing & Validation

Build and link:
- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm link`

Smoke tests:
- [ ] `node dist/index.js --help` (direct import-resolution check; run without `npm link`)
- [ ] `copilot-server --help` (verify usage output)
- [ ] `copilot-server --auto-auth` (complete device flow; ensure `.auth.json` is created in current directory as before)
- [ ] `copilot-server --port=8069` (start server)
- [ ] `curl http://127.0.0.1:8069/` (health)
- [ ] `curl http://127.0.0.1:8069/v1/models` (requires auth)
- [ ] `curl http://127.0.0.1:8069/auth/status`

Shutdown behavior:
- [ ] While server is running, press Ctrl+C (SIGINT) and verify: shutdown logs appear; `server.close()` and `connectionPool.close()` are invoked; no unhandled rejections.

Windows CLI:
- [ ] On PowerShell and CMD: `copilot-server --help` and `copilot-server --port=8069` to confirm wrapper works across shells.

Non-streaming request:
- [ ] POST `/v1/chat/completions` with a small JSON payload (OpenAI-compatible)

Streaming request:
- [ ] POST `/v1/chat/completions` with `"stream": true`; verify incremental SSE

Middleware checks:
- [ ] Compression headers appear when enabled
- [ ] Cache headers present
- [ ] Request size validation works
- [ ] Circuit breaker endpoints respond

Logging:
- [ ] Startup logs print endpoints & metrics
- [ ] Streaming logs show chunk progress

Optional (dev-only):
- If you keep Bun locally for tests, you can continue to run existing Bun-based test scripts. End users won’t need Bun.

---

## 5) Compatibility notes (Bun → Node)

- Server startup:
  - `Bun.serve` → `@hono/node-server` `serve({ fetch, port, hostname })`
- Web APIs:
  - Node 18+ provides `fetch`, `Response`, `Headers`, `ReadableStream`, `TextDecoder` — compatible with current streaming logic
- Networking:
  - Already uses `undici` for pooled requests/streams; fully Node-ready
- Auth storage:
  - `src/auth.ts` writes `.auth.json` to `process.cwd()`; unchanged by migration
- Types/ESM:
  - Project remains ESM (`"type": "module"`); ensure `@types/node` are included and Bun types removed

Potential follow-ups (optional):
- Move `.auth.json` to a per-user config directory instead of `cwd`
- Add Node unit tests to replace Bun’s test runner

---

## 6) Rollback Instructions

If you need to revert to Bun-based runtime quickly:

- [ ] Revert `src/server.ts` start to `Bun.serve({ fetch, port, hostname })`
- [ ] Restore shebang to `#!/usr/bin/env bun` if you changed it
- [ ] Restore `package.json` scripts:
  - `"build": "bun build src/index.ts --outdir dist --target bun"`
  - `"start": "bun run src/index.ts"`
- [ ] Restore Bun types (`@types/bun`) and tsconfig `"types": ["bun-types"]`
- [ ] If bin points to Node wrapper, point it back to a Bun wrapper if desired
- [ ] If you added a bundler (e.g., `tsup`): optionally remove it from `devDependencies` and restore the original `build` script, or leave it unused.


Using Git, a single revert of the migration commit (or branch reset) will restore the previous Bun-based state.

---

## 7) Checklist Summary

- [ ] Replace `Bun.serve` with `@hono/node-server` `serve()`
- [ ] Add `@hono/node-server`, `@types/node`; remove Bun types
- [ ] Switch build to a bundler (`tsup`), run with `node dist/index.js`
- [ ] Ensure `bin` maps to a Node wrapper (`bin/cli.js`) or shebang entry
- [ ] Validate auth, non-streaming & streaming endpoints, middleware
- [ ] Publish to npm; end users need only Node.js

## 8) Risks & Mitigations (Read This Before Migrating)

High-risk: Node ESM import resolution for internal, extensionless imports
- Symptom: `node dist/index.js` fails with `ERR_MODULE_NOT_FOUND` when imports lack `.js`.
- Mitigation A (recommended): Bundle with `tsup` (this plan’s default). Resolves specifiers at build time; no `.js` changes needed.
- Mitigation B (alternative): Use `"module": "NodeNext"`, `"moduleResolution": "NodeNext"` and add `.js` to ALL relative internal imports in source. Larger diff, no bundler.

Other risks:
- Shutdown API mismatch: Replace `this.server.stop()` (Bun) with `this.server.close()` (Node). Covered in plan.
- Web Streams typings: If TS complains about `ReadableStream`, add `"lib": ["ES2022", "DOM"]` (included above) or use Node 20+ types.
- @hono/node-server return type: Confirm it returns a `http.Server`-like instance exposing `close(cb)`. If API changes, adapt shutdown accordingly.
- Windows CLI shims: Prefer the Node wrapper (`bin/cli.js`). Test on PowerShell and CMD.


