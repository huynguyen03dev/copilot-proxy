# Bun to Node.js Test Runner Migration Status

## ✅ Completed Tasks

### 1. Core Infrastructure
- [x] Updated `tests/setup.ts` to use `node:test` hooks
- [x] Created `tests/helpers/assertions.ts` with expect-style API
- [x] Updated `package.json` test scripts
- [x] Updated Node engine requirement to `>=20.0.0`
- [x] Created migration documentation in `docs/MIGRATION_BUN_TO_NODE.md`
- [x] Created migration script `scripts/migrate-tests-to-node.js`

### 2. Unit Test Files Migrated
- [x] `tests/unit/services/chatService.test.ts`
- [x] `tests/unit/services/streamingService.test.ts`
- [x] `tests/unit/services/pingDetectionService.test.ts`
- [x] `tests/unit/services/responseTransformService.test.ts`
- [x] `tests/unit/auth.test.ts`
- [x] `tests/unit/config.test.ts`
- [x] `tests/unit/content.test.ts`
- [x] `tests/unit/errorBoundary.test.ts`
- [x] `tests/unit/logger.test.ts`
- [x] `tests/unit/requestSize.test.ts`
- [x] `tests/unit/role-normalization.test.ts`
- [x] `tests/unit/types.test.ts`

### 3. Integration Test Files Migrated
- [x] `tests/integration/streaming-integration.test.ts`
- [x] `tests/integration/enhanced-integration.test.ts`
- [x] `tests/integration/error-scenarios.test.ts`

## 🔄 Remaining Tasks

### Phase 2: Finalize Migration (IN PROGRESS)

#### 1. Install Required Dependencies
```bash
npm install --save-dev @types/node
```

**Why**: Provides TypeScript type definitions for Node.js built-in modules including `node:test`.

#### 2. Remove Bun-Specific Files
```bash
# Remove Bun test runners
rm tests/run-unit-tests.ts
rm tests/integration/run-integration-tests.ts
```

**Files to remove**:
- `tests/run-unit-tests.ts` (243 lines) - Bun-specific unit test runner
- `tests/integration/run-integration-tests.ts` (348 lines) - Bun-specific integration test runner

#### 3. Run Tests and Fix Issues
```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration
```

**Expected issues to fix**:
- Import path issues (missing `.js` extensions)
- Async assertion patterns that need manual conversion
- Any Bun-specific APIs that need Node.js equivalents

#### 4. Update Documentation

**Files to update**:
- [ ] `README.md` - Update test running instructions
- [ ] Remove any Bun installation/setup instructions
- [ ] Add Node.js 20+ requirement prominently
- [ ] Update "Running Tests" section with new npm scripts

**Search for Bun references**:
```bash
# Find all Bun references in docs
grep -r "bun" docs/ --include="*.md"
grep -r "Bun" docs/ --include="*.md"
```

### Phase 3: Integration Tests (NEXT)

#### 1. Verify Integration Tests Work
- [ ] Test server startup/shutdown in integration tests
- [ ] Verify SSE streaming works with Node.js test runner
- [ ] Check async test handling

#### 2. Add Test Coverage Reporting
```bash
# Already configured in package.json
npm test  # Runs with --experimental-test-coverage
```

### Phase 4: Documentation and Cleanup (FINAL)

#### 1. Update CI/CD Configuration
- [ ] Update GitHub Actions workflow (if exists)
- [ ] Update any other CI configuration
- [ ] Ensure Node 20+ is used in CI

#### 2. Final Documentation Updates
- [ ] Update CONTRIBUTING.md (if exists)
- [ ] Update any developer setup guides
- [ ] Add troubleshooting section for common test issues

#### 3. Verify No Bun References Remain
```bash
# Search entire codebase
grep -r "bun:test" . --include="*.ts" --include="*.js"
grep -r "#!/usr/bin/env bun" . --include="*.ts" --include="*.js"
```

## 📝 Migration Summary

### What Changed

**Before (Bun)**:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { MyService } from '../../src/services/myService'

describe('MyService', () => {
  beforeAll(() => { /* setup */ })
  afterAll(() => { /* cleanup */ })
  
  it('should work', () => {
    expect(result).toBe(expected)
  })
})
```

**After (Node.js)**:
```typescript
import { describe, it, before, after } from 'node:test'
import { expect } from '../helpers/assertions.js'
import { MyService } from '../../src/services/myService.js'

describe('MyService', () => {
  before(() => { /* setup */ })
  after(() => { /* cleanup */ })
  
  it('should work', () => {
    expect(result).toBe(expected)
  })
})
```

### Key Changes
1. **Test Runner**: `bun:test` → `node:test`
2. **Assertions**: Custom `expect()` helper wrapping Node's `assert`
3. **Lifecycle Hooks**: `beforeAll/afterAll` → `before/after`
4. **Import Extensions**: Added `.js` to all local imports
5. **Node Version**: Requires Node.js >= 20.0.0

### Benefits
- ✅ No external test framework dependencies
- ✅ Native Node.js support
- ✅ Built-in coverage reporting
- ✅ Faster CI/CD (no Bun installation needed)
- ✅ Better IDE support with standard Node.js

## 🚀 Next Steps

1. **Install @types/node**:
   ```bash
   npm install --save-dev @types/node
   ```

2. **Remove Bun runner files**:
   ```bash
   rm tests/run-unit-tests.ts
   rm tests/integration/run-integration-tests.ts
   ```

3. **Run tests**:
   ```bash
   npm test
   ```

4. **Fix any failing tests** - Review error messages and update code as needed

5. **Update documentation** - Remove Bun references, add Node.js requirements

6. **Commit changes**:
   ```bash
   git add .
   git commit -m "Migrate from Bun to Node.js test runner"
   ```

## 📊 Migration Statistics

- **Total test files migrated**: 15
  - Unit tests: 12
  - Integration tests: 3
- **Files created**: 3
  - `tests/helpers/assertions.ts`
  - `scripts/migrate-tests-to-node.js`
  - `docs/MIGRATION_BUN_TO_NODE.md`
- **Files to remove**: 2
  - `tests/run-unit-tests.ts`
  - `tests/integration/run-integration-tests.ts`
- **Lines of code changed**: ~50 lines across 15 files

## ⚠️ Known Issues

1. **TypeScript errors for `node:test`**: Install `@types/node` to resolve
2. **Some async patterns**: May need manual review and conversion
3. **Node.js not in PATH**: Ensure Node.js 20+ is installed and in system PATH

## 🔗 Related Documentation

- [Node.js Test Runner Docs](https://nodejs.org/api/test.html)
- [Migration Guide](docs/MIGRATION_BUN_TO_NODE.md)
- [Assertion Helpers](tests/helpers/assertions.ts)

