# Migration from Bun to Node.js Test Runner

## Overview

This document tracks the migration from Bun's test runner to Node.js built-in test runner (`node:test`).

## Changes Made

### 1. Core Infrastructure ✅

- **tests/setup.ts**: Updated to use `node:test` hooks (`before`, `after`, `beforeEach`)
- **tests/helpers/assertions.ts**: Created expect-style assertion helpers wrapping Node's `assert` module
- **package.json**: 
  - Updated test scripts to use `node --test`
  - Added `test:unit`, `test:integration`, `test:watch` scripts
  - Updated Node engine requirement to `>=20.0.0`
- **scripts/migrate-tests-to-node.js**: Created migration helper script

### 2. Test Files Migration Status

#### Unit Tests

- [x] `tests/unit/services/chatService.test.ts`
- [x] `tests/unit/services/streamingService.test.ts`
- [x] `tests/unit/services/pingDetectionService.test.ts` (partial)
- [x] `tests/unit/services/responseTransformService.test.ts` (partial)
- [ ] `tests/unit/auth.test.ts`
- [ ] `tests/unit/config.test.ts`
- [ ] `tests/unit/content.test.ts`
- [ ] `tests/unit/errorBoundary.test.ts`
- [ ] `tests/unit/logger.test.ts`
- [ ] `tests/unit/requestSize.test.ts`
- [ ] `tests/unit/role-normalization.test.ts`
- [ ] `tests/unit/types.test.ts`

#### Integration Tests

- [x] `tests/integration/streaming-integration.test.ts` (partial)
- [ ] `tests/integration/enhanced-integration.test.ts`
- [ ] `tests/integration/error-scenarios.test.ts`

### 3. Migration Pattern

For each test file, apply these changes:

```typescript
// BEFORE (Bun)
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test'
import { MyService } from '../../src/services/myService'

// AFTER (Node)
import { describe, it, beforeEach, before, after } from 'node:test'
import { expect } from '../helpers/assertions.js'
import { MyService } from '../../src/services/myService.js'
```

**Key changes:**
1. Replace `'bun:test'` with `'node:test'`
2. Import `expect` from `'../helpers/assertions.js'` (adjust path as needed)
3. Add `.js` extensions to all local imports
4. Replace `beforeAll` → `before`
5. Replace `afterAll` → `after`
6. Replace `expect(async () => ...).not.toThrow()` with `expectAsyncNotToThrow(async () => ...)`

### 4. Assertion API Mapping

Our custom `expect()` helper supports:

| Bun/Jest Style | Node Helper | Notes |
|----------------|-------------|-------|
| `expect(x).toBe(y)` | `expect(x).toBe(y)` | ✅ Supported |
| `expect(x).toEqual(y)` | `expect(x).toEqual(y)` | ✅ Supported (deep equal) |
| `expect(x).toBeDefined()` | `expect(x).toBeDefined()` | ✅ Supported |
| `expect(x).toBeNull()` | `expect(x).toBeNull()` | ✅ Supported |
| `expect(x).toBeInstanceOf(Y)` | `expect(x).toBeInstanceOf(Y)` | ✅ Supported |
| `expect(x).toHaveProperty('y')` | `expect(x).toHaveProperty('y')` | ✅ Supported |
| `expect(x).toHaveLength(n)` | `expect(x).toHaveLength(n)` | ✅ Supported |
| `expect(x).toMatch(/regex/)` | `expect(x).toMatch(/regex/)` | ✅ Supported |
| `expect(x).toContain(y)` | `expect(x).toContain(y)` | ✅ Supported |
| `expect(x).toBeGreaterThan(y)` | `expect(x).toBeGreaterThan(y)` | ✅ Supported |
| `expect(x).toBeLessThan(y)` | `expect(x).toBeLessThan(y)` | ✅ Supported |
| `expect(x).not.toBe(y)` | `expect(x).not.toBe(y)` | ✅ Supported |
| `expect(() => fn()).toThrow()` | `expect(() => fn()).toThrow()` | ✅ Supported |
| `await expect(async () => ...).not.toThrow()` | `await expectAsyncNotToThrow(async () => ...)` | ⚠️ Different API |

### 5. Files to Remove

After migration is complete:

- [ ] `tests/run-unit-tests.ts` (Bun-specific runner)
- [ ] `tests/integration/run-integration-tests.ts` (if Bun-specific)
- [ ] Any `#!/usr/bin/env bun` shebangs

### 6. Documentation Updates Needed

- [ ] Update README.md with Node.js test instructions
- [ ] Remove Bun installation instructions
- [ ] Add Node 20+ requirement
- [ ] Update CI/CD configuration (if exists)

## Running Tests

### Local Development

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Watch mode
npm run test:watch
```

### Requirements

- Node.js >= 20.0.0 (for native test runner and Web APIs)
- No additional test framework dependencies needed

## Known Issues / Manual Review Needed

1. **Async expect patterns**: Some `await expect(async () => ...).not.toThrow()` need manual conversion to `expectAsyncNotToThrow()`
2. **Complex matchers**: Some advanced matchers may need custom implementation
3. **Test isolation**: Ensure tests don't rely on Bun-specific behaviors
4. **Performance**: Node's test runner may have different performance characteristics

## Next Steps

1. Complete migration of remaining test files
2. Run full test suite and fix any failures
3. Update CI/CD pipelines
4. Remove Bun-specific files and references
5. Update documentation

## Rollback Plan

If issues arise, the migration can be rolled back by:
1. Reverting package.json changes
2. Reverting test file changes
3. Removing `tests/helpers/assertions.ts`
4. Restoring Bun test runner

Git commit before migration: [To be filled]

