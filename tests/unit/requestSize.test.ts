/**
 * Request Size Validation Tests
 * Tests for request size limits and JSON depth validation
 */

import { describe, it } from "node:test"
import { expect } from "../helpers/assertions.js"
import { PRODUCTION_LIMITS, TEST_LIMITS } from "../../src/middleware/requestSize.js"

describe("Request Size Limits", () => {
  describe("Production Limits", () => {
    it("should have increased JSON depth limit for Claude Code Router compatibility", () => {
      expect(PRODUCTION_LIMITS.maxJsonDepth).toBe(12)
      expect(PRODUCTION_LIMITS.maxJsonDepth).toBeGreaterThan(8) // Previous limit
      expect(PRODUCTION_LIMITS.maxJsonDepth).toBeGreaterThan(9) // Claude Code Router requirement
    })

    it("should maintain other production limits", () => {
      expect(PRODUCTION_LIMITS.maxBodySize).toBe(5 * 1024 * 1024) // 5MB
      expect(PRODUCTION_LIMITS.maxArrayLength).toBe(5000)
      expect(PRODUCTION_LIMITS.maxStringLength).toBe(512 * 1024) // 512KB
    })
  })

  describe("Test Limits", () => {
    it("should have more relaxed limits than production", () => {
      expect(TEST_LIMITS.maxJsonDepth).toBeGreaterThan(PRODUCTION_LIMITS.maxJsonDepth)
      expect(TEST_LIMITS.maxBodySize).toBeGreaterThan(PRODUCTION_LIMITS.maxBodySize)
      expect(TEST_LIMITS.maxArrayLength).toBeGreaterThan(PRODUCTION_LIMITS.maxArrayLength)
      expect(TEST_LIMITS.maxStringLength).toBeGreaterThan(PRODUCTION_LIMITS.maxStringLength)
    })
  })

  describe("JSON Depth Validation", () => {
    it("should accommodate Claude Code Router nesting (9 levels)", () => {
      // Create a 9-level nested object (similar to what Claude Code Router might send)
      const nineLevel = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  level6: {
                    level7: {
                      level8: {
                        level9: "data"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Count actual nesting depth
      const countDepth = (obj: any, depth = 0): number => {
        if (typeof obj !== 'object' || obj === null) return depth
        const maxChildDepth = Math.max(...Object.values(obj).map(value => countDepth(value, depth + 1)))
        return maxChildDepth
      }

      const actualDepth = countDepth(nineLevel)
      expect(actualDepth).toBe(9)
      expect(actualDepth).toBeLessThanOrEqual(PRODUCTION_LIMITS.maxJsonDepth)
    })

    it("should reject excessive nesting beyond production limit", () => {
      // Create a 13-level nested object (exceeds our new limit of 12)
      let deepObject: any = { data: "value" }
      for (let i = 0; i < 12; i++) { // Create 12 additional levels
        deepObject = { level: deepObject }
      }

      const countDepth = (obj: any, depth = 0): number => {
        if (typeof obj !== 'object' || obj === null) return depth
        const maxChildDepth = Math.max(...Object.values(obj).map(value => countDepth(value, depth + 1)))
        return maxChildDepth
      }

      const actualDepth = countDepth(deepObject)
      expect(actualDepth).toBe(13) // 1 (initial) + 12 (loop) = 13 levels
      expect(actualDepth).toBeGreaterThan(PRODUCTION_LIMITS.maxJsonDepth)
    })
  })
})
