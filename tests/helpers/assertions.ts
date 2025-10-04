/**
 * Assertion helpers for Node.js test runner
 * Provides expect-style API wrapping Node's assert module
 */

import assert from "node:assert/strict"

/**
 * Expect-style assertion wrapper for better test readability
 */
export function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      assert.strictEqual(actual, expected)
    },
    
    toEqual(expected: T) {
      assert.deepStrictEqual(actual, expected)
    },
    
    toBeGreaterThan(expected: number) {
      assert.ok(
        typeof actual === "number" && actual > expected,
        `Expected ${actual} to be greater than ${expected}`
      )
    },
    
    toBeGreaterThanOrEqual(expected: number) {
      assert.ok(
        typeof actual === "number" && actual >= expected,
        `Expected ${actual} to be greater than or equal to ${expected}`
      )
    },
    
    toBeLessThan(expected: number) {
      assert.ok(
        typeof actual === "number" && actual < expected,
        `Expected ${actual} to be less than ${expected}`
      )
    },
    
    toBeLessThanOrEqual(expected: number) {
      assert.ok(
        typeof actual === "number" && actual <= expected,
        `Expected ${actual} to be less than or equal to ${expected}`
      )
    },
    
    toBeDefined() {
      assert.notStrictEqual(actual, undefined)
    },
    
    toBeUndefined() {
      assert.strictEqual(actual, undefined)
    },
    
    toBeNull() {
      assert.strictEqual(actual, null)
    },
    
    toBeTruthy() {
      assert.ok(actual, `Expected ${actual} to be truthy`)
    },
    
    toBeFalsy() {
      assert.ok(!actual, `Expected ${actual} to be falsy`)
    },
    
    toContain(expected: any) {
      if (typeof actual === "string") {
        assert.ok(
          actual.includes(expected),
          `Expected "${actual}" to contain "${expected}"`
        )
      } else if (Array.isArray(actual)) {
        assert.ok(
          actual.includes(expected),
          `Expected array to contain ${expected}`
        )
      } else {
        throw new Error("toContain only works with strings and arrays")
      }
    },
    
    toHaveLength(expected: number) {
      assert.ok(
        actual && typeof (actual as any).length === "number",
        "Expected value to have a length property"
      )
      assert.strictEqual((actual as any).length, expected)
    },
    
    toHaveProperty(property: string, value?: any) {
      assert.ok(
        actual && typeof actual === "object" && property in actual,
        `Expected object to have property "${property}"`
      )
      if (value !== undefined) {
        assert.strictEqual((actual as any)[property], value)
      }
    },
    
    toMatch(pattern: RegExp) {
      assert.ok(
        typeof actual === "string" && pattern.test(actual),
        `Expected "${actual}" to match ${pattern}`
      )
    },
    
    toMatchObject(expected: Partial<T>) {
      assert.ok(actual && typeof actual === "object", "Expected value to be an object")
      for (const [key, value] of Object.entries(expected)) {
        assert.deepStrictEqual(
          (actual as any)[key],
          value,
          `Expected property "${key}" to match`
        )
      }
    },
    
    toBeInstanceOf(constructor: any) {
      assert.ok(
        actual instanceof constructor,
        `Expected value to be instance of ${constructor.name}`
      )
    },
    
    toThrow(expectedError?: string | RegExp | Error) {
      assert.ok(
        typeof actual === "function",
        "Expected value to be a function"
      )
      
      if (expectedError === undefined) {
        assert.throws(actual as any)
      } else if (typeof expectedError === "string") {
        assert.throws(actual as any, new Error(expectedError))
      } else if (expectedError instanceof RegExp) {
        assert.throws(actual as any, expectedError)
      } else {
        assert.throws(actual as any, expectedError)
      }
    },
    
    // Negation support
    not: {
      toBe(expected: T) {
        assert.notStrictEqual(actual, expected)
      },
      
      toEqual(expected: T) {
        assert.notDeepStrictEqual(actual, expected)
      },
      
      toBeDefined() {
        assert.strictEqual(actual, undefined)
      },
      
      toBeNull() {
        assert.notStrictEqual(actual, null)
      },
      
      toContain(expected: any) {
        if (typeof actual === "string") {
          assert.ok(
            !actual.includes(expected),
            `Expected "${actual}" not to contain "${expected}"`
          )
        } else if (Array.isArray(actual)) {
          assert.ok(
            !actual.includes(expected),
            `Expected array not to contain ${expected}`
          )
        } else {
          throw new Error("toContain only works with strings and arrays")
        }
      },
      
      toThrow() {
        assert.ok(
          typeof actual === "function",
          "Expected value to be a function"
        )
        assert.doesNotThrow(actual as any)
      }
    }
  }
}

/**
 * Async expect wrapper for promises
 */
export async function expectAsync<T>(promise: Promise<T>) {
  const actual = await promise
  return expect(actual)
}

/**
 * Helper to assert that an async function throws
 */
export async function expectAsyncToThrow(
  fn: () => Promise<any>,
  expectedError?: string | RegExp | Error
): Promise<void> {
  if (expectedError === undefined) {
    await assert.rejects(fn)
  } else if (typeof expectedError === "string") {
    await assert.rejects(fn, new Error(expectedError))
  } else if (expectedError instanceof RegExp) {
    await assert.rejects(fn, expectedError)
  } else {
    await assert.rejects(fn, expectedError)
  }
}

/**
 * Helper to assert that an async function does not throw
 */
export async function expectAsyncNotToThrow(fn: () => Promise<any>): Promise<void> {
  await assert.doesNotReject(fn)
}

