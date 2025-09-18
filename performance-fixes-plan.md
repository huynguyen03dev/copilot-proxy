# Performance Fixes Implementation Plan

Scope: Implement the highest‑impact performance improvements for the Bun + TypeScript Hono proxy. Prioritized focus:
- Critical: (1) Streaming validation middleware buffering, (2) Unbounded connection pool queues, (3) Streaming timeout misalignment
- Additional: Compression threshold, ETag generation guardrails, Endpoint discovery optimization

Metrics of success (target deltas under realistic load):
- Latency: Reduce P95 by ≥100ms on large JSON requests; prevent spurious stream aborts
- Throughput: Stable RPS under concurrency (no collapse due to GC/queue growth)
- Memory: No unbounded growth; RSS steady under stress (e.g., <300MB @ 100 concurrent)
- Reliability: Streaming completion rate ↑ and fewer 5xx from timeouts

---

## Phase 1 — Quick Wins (Highest Impact First)

### - [ ] Task 1 — Disable current streaming validation (avoids whole‑body buffering)
- File: `src/server.ts`
- Lines: 237–241 (middleware registration)
- Action: Comment out or remove the streaming validation middleware for now; rely on single‑pass request size middleware.
- Before:
```ts
// Streaming validation middleware (for large requests)
this.app.use("*", streamingValidationMiddleware(
  this.IS_TEST_ENVIRONMENT ? TEST_STREAMING_CONFIG : PRODUCTION_STREAMING_CONFIG
))
```
- After:
```ts
// Streaming validation temporarily disabled to avoid full-body buffering
// this.app.use("*", streamingValidationMiddleware(
//   this.IS_TEST_ENVIRONMENT ? TEST_STREAMING_CONFIG : PRODUCTION_STREAMING_CONFIG
// ))
```
- Expected impact: 
  - Memory: eliminates multi‑MB buffering per request; reduces GC churn
  - Latency: saves 100–1000ms on large bodies (no duplicate parse)
- Testing:
  - Send 5–20MB JSON POSTs to `/v1/chat/completions` and monitor RSS/latency vs baseline
  - Ensure `requestSize` middleware still validates and rejects over‑limit bodies

### - [ ] Task 2 — Align streaming timeouts (prevent spurious aborts)
- File: `src/server.ts`
- Lines: ~1110–1123 (in `forwardToCopilotStreaming` call to `connectionPool.streamRequest`)
- Action: Increase network body timeout to ≥ chunk timeout (30s) or disable. Safer: 60s.
- Before:
```ts
const response = await connectionPool.streamRequest(url, {
  method: "POST",
  headers: { /* ... */ },
  body: JSON.stringify(streamingRequestBody),
  timeout: 15000 // 15s
})
```
- After:
```ts
const response = await connectionPool.streamRequest(url, {
  method: "POST",
  headers: { /* ... */ },
  body: JSON.stringify(streamingRequestBody),
  timeout: 60000 // align with 30s chunk timeout; avoid premature aborts
})
```
- Expected impact: 
  - Reliability: fewer dropped streams; higher completion rate
  - Latency: avoids unnecessary retries/timeouts; smoother P99
- Testing:
  - Integration: simulate chunk gaps of 20–25s; verify stream does not abort
  - Observe error logs for fewer `bodyTimeout`/abort events

### - [ ] Task 3 — Raise compression threshold in dev (avoid recompression overhead)
- File: `src/middleware/streamingValidation.ts`
- Lines: ~394–401 (DEFAULT_COMPRESSION_CONFIG)
- Action: Increase `threshold` to reduce CPU/memory cost in dev.
- Before:
```ts
export const DEFAULT_COMPRESSION_CONFIG = {
  threshold: 6144,
  enableForSSE: false,
  trackStats: true,
  algorithms: ['gzip', 'deflate'],
  skipApiEndpoints: false
}
```
- After:
```ts
export const DEFAULT_COMPRESSION_CONFIG = {
  threshold: 24 * 1024, // 24KB — reduce recompression costs for medium responses
  enableForSSE: false,
  trackStats: true,
  algorithms: ['gzip', 'deflate'],
  skipApiEndpoints: false
}
```
- Expected impact:
  - Latency: avoids 50–200ms recompression costs on medium responses in dev
- Testing:
  - Benchmark JSON endpoints at 8–20KB; confirm fewer compressions and lower CPU

---

## Phase 2 — Memory Management

### - [ ] Task 4 — Replace/Refactor streaming validator to be truly streaming (or keep disabled)
- File: `src/middleware/streamingValidation.ts`
- Lines: 273–279 (uses `c.req.arrayBuffer()`), 56–104 (`validateChunk` accumulates `buffer`)
- Action (Option A now): keep disabled (Task 1). 
- Action (Option B later): implement incremental read using `c.req.raw.body!.getReader()` and avoid building a full string; maintain only rolling context necessary for depth/strings.
- Before (problematic extract):
```ts
const body = await c.req.arrayBuffer()
const chunks = splitIntoChunks(new Uint8Array(body), finalConfig.maxChunkSize)
```
- After (sketch):
```ts
const reader = c.req.raw.body!.getReader()
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  const r = validator.validateChunk(value)
  if (!r.valid) return c.json(err(r.error), 400)
}
if (!validator.isJsonComplete()) return c.json(err('truncated'), 400)
```
- Expected impact: 
  - Memory: constant‑space validation for large payloads
  - Latency: removes extra copy/parse cost
- Testing:
  - Stream large JSON and verify peak RSS does not scale with body size

### - [ ] Task 5 — Bound and time‑limit per‑origin wait queues in connection pool
- File: `src/utils/connectionPool.ts`
- Lines:
  - Add config fields: ~14–24 (`ConnectionPoolConfig`)
  - Modify `acquire`: 121–148
  - Modify constructor defaults: 61–79
- Action: Introduce `maxQueueSize`, `queueTimeoutMs`. Reject when saturated or waiting too long.
- Before (config):
```ts
export interface ConnectionPoolConfig {
  maxConnections: number
  maxConcurrentRequests: number
  /* ... */
}
```
- After (config):
```ts
export interface ConnectionPoolConfig {
  maxConnections: number
  maxConcurrentRequests: number
  /* ... */
  maxQueueSize: number
  queueTimeoutMs: number
}
```
- Before (constructor defaults excerpt):
```ts
this.config = {
  maxConnections: 10,
  maxConcurrentRequests: 100,
  /* ... */
  ...config
}
```
- After (constructor defaults excerpt):
```ts
this.config = {
  maxConnections: 10,
  maxConcurrentRequests: 100,
  /* ... */
  maxQueueSize: 200,         // ~2x maxConcurrentRequests per origin
  queueTimeoutMs: 5000,      // fail fast under overload
  ...config
}
```
- Before (acquire excerpt):
```ts
if (currentInFlight < this.config.maxConcurrentRequests) {
  this.inFlightCount.set(origin, currentInFlight + 1)
  /* ... */
  return
}
// Slow path: must wait in queue
return new Promise<void>((resolve) => {
  const queue = this.waitQueues.get(origin) || []
  queue.push({ resolve, timestamp: startWaitTime })
  this.waitQueues.set(origin, queue)
})
```
- After (acquire excerpt with bounds):
```ts
if (currentInFlight < this.config.maxConcurrentRequests) {
  this.inFlightCount.set(origin, currentInFlight + 1)
  const stats = this.stats.get(origin); if (stats) stats.activeConnections++
  this.updateDerivedStats(origin)
  return
}
const start = Date.now()
const queue = this.waitQueues.get(origin) || []
if (queue.length >= this.config.maxQueueSize) {
  throw new Error('QUEUE_SATURATED')
}
return new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error('QUEUE_TIMEOUT'))
  }, this.config.queueTimeoutMs)
  queue.push({
    resolve: () => { clearTimeout(timeout); resolve() },
    timestamp: start
  })
  this.waitQueues.set(origin, queue)
})
```
- Expected impact:
  - Memory: prevents unbounded promise/object growth in queues
  - Latency/Throughput: fail‑fast shedding stabilizes P95/P99 and event loop
- Testing:
  - Unit: flood with > (maxConcurrent + maxQueueSize) pending; expect immediate rejection with `QUEUE_SATURATED`
  - Integration: simulate slow upstream, verify 503/504 responses instead of piling up

---

## Phase 3 — Concurrency Fixes

### - [ ] Task 6 — Handle queue saturation/timeout at call sites with 503/504
- File: `src/server.ts`
- Lines:
  - Non‑streaming upstream call: ~949–963
  - Streaming upstream call: ~1112–1123
  - Discovery attempts: ~817–831
- Action: Wrap `connectionPool.request/streamRequest` and map `QUEUE_SATURATED`→503, `QUEUE_TIMEOUT`→504 with helpful JSON error.
- Example wrapper (apply in each call site):
```ts
try {
  const resp = await connectionPool.streamRequest(/* ... */)
  // ...
} catch (e: any) {
  if (e?.message === 'QUEUE_SATURATED') return c.json(err('Server overloaded'), 503)
  if (e?.message === 'QUEUE_TIMEOUT') return c.json(err('Upstream busy'), 504)
  throw e
}
```
- Expected impact: 
  - Reliability: graceful overload handling; avoids request pile‑ups
- Testing:
  - Force saturation (Task 5) and verify proper status/messaging

### - [ ] Task 7 — Lightweight overload guard for streaming admissions
- File: `src/server.ts`
- Lines: ~567–588 (before admitting new stream)
- Action: Add heuristic: if `activeStreams >= 0.9 * MAX_CONCURRENT_STREAMS` or pool `queuedRequests` elevated, reject new streams with 503 and `Retry-After`.
- Example:
```ts
const overall = connectionPool.getOverallStats()
if (this.activeStreams.size >= Math.floor(0.9 * this.MAX_CONCURRENT_STREAMS) || overall.queuedRequests > 0.8 * overall.activeConnections) {
  c.header('Retry-After', '2')
  return c.json(err('Server is busy; retry shortly'), 503)
}
```
- Expected impact: 
  - Latency/Throughput: reduces tail latency and stabilizes under bursts
- Testing:
  - Stress test: verify early shedding and recovery behavior

---

## Phase 4 — Architecture Improvements

### - [ ] Task 8 — Isolate compression middleware (clarity, risk reduction)
- Files: move compression from `src/middleware/streamingValidation.ts` to `src/middleware/compression.ts`; update imports in `src/server.ts`.
- Action: Extract `compressionMiddleware` + configs; avoid duplicate imports in the mixed file.
- Expected impact: 
  - Maintainability & predictable middleware costs
- Testing:
  - Verify compression still applies/skips correctly; regression test for SSE

### - [ ] Task 9 — Guard ETag generation by size to avoid buffering large bodies
- File: `src/middleware/cacheHeaders.ts`
- Lines: ~248–286 (ETag section)
- Action: If `Content-Length` header > 32KB (or missing), skip ETag; avoid calling `response.text()` for large bodies.
- Example:
```ts
const len = Number(response.headers.get('content-length') || 0)
if (!Number.isFinite(len) || len > 32 * 1024) {
  // skip ETag generation for large/unknown bodies
} else {
  const body = await response.text()
  headers.set('ETag', generateETag(body))
}
```
- Expected impact:
  - Latency/CPU: avoid expensive buffer copies for medium/large responses
- Testing:
  - Serve 64KB+ JSON; confirm ETag omitted and no extra buffering

### - [ ] Task 10 — Endpoint discovery: reduce probe cost
- File: `src/server.ts`
- Lines: ~808–831 (building discovery request bodies)
- Action: Use a minimal discovery payload and short `max_tokens` strictly for discovery; keep `stream:false`.
- Example:
```ts
const discoveryBody = { model: request.model, messages: [{ role:'user', content:'ping' }], max_tokens: 1, temperature: 0, stream: false }
// use discoveryBody instead of full transformed messages for discovery attempts
```
- Expected impact:
  - Throughput/Upstream load: less wasted CPU/bandwidth when aborting losers; faster first‑hit success
- Testing:
  - Compare time and upstream CPU for parallel discovery before/after

---

## Dependencies
- Task 5 (queue bounds) precedes Task 6 (caller handling)
- Task 1 (disable streaming validator) should land before Task 4 (refactor) if chosen
- Task 2 (timeout) independent; do ASAP
- Task 8 (compression extraction) independent; schedule after quick wins

---

## Validation & Measurement
- Bench scripts: use `bun test tests/integration/run-integration-tests.ts` and ad‑hoc load via `wrk`/`k6` against:
  - Large JSON POST to `/v1/chat/completions` (non‑streaming)
  - Streaming POST with artificial slow chunk producer (integration stub)
- Track:
  - /metrics: `streams.active`, `peakConcurrent`, `connectionPool.queuedRequests`, `averageResponseTime`
  - Logs: fewer `bodyTimeout`, `QUEUE_SATURATED`, `QUEUE_TIMEOUT` should be rare post‑tuning
- Success criteria:
  - P95 latency reduced ≥100ms on large inputs (Task 1/3)
  - No unbounded RSS increase under overload (Task 5/6)
  - Streaming completion rate ↑; no premature abort at 15s gaps (Task 2)

---

## Progress Checklist (rollup)
- [ ] Task 1 — Disable streaming validation middleware
- [ ] Task 2 — Align streaming timeouts (60000ms)
- [ ] Task 3 — Raise dev compression threshold (24KB)
- [ ] Task 4 — (Optional) True streaming validator
- [ ] Task 5 — Queue bounds/timeouts in connection pool
- [ ] Task 6 — Map QUEUE_* to 503/504 at call sites
- [ ] Task 7 — Overload guard for streaming admissions
- [ ] Task 8 — Extract compression middleware to its own file
- [ ] Task 9 — ETag guard by size (skip when >32KB)
- [ ] Task 10 — Minimal payload for endpoint discovery

