#!/usr/bin/env node

/**
 * Script to migrate test files from Bun test runner to Node.js test runner
 * 
 * This script:
 * 1. Replaces bun:test imports with node:test
 * 2. Adds .js extensions to local imports
 * 3. Updates expect imports to use our assertion helpers
 * 4. Handles async expect patterns
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.join(__dirname, '..')

async function findTestFiles(dir) {
  const files = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await findTestFiles(fullPath))
    } else if (entry.name.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }
  
  return files
}

async function migrateTestFile(filePath) {
  console.log(`Migrating: ${path.relative(rootDir, filePath)}`)
  
  let content = await fs.readFile(filePath, 'utf-8')
  let modified = false
  
  // 1. Replace bun:test imports with node:test
  if (content.includes("from 'bun:test'") || content.includes('from "bun:test"')) {
    // Extract what's being imported
    const bunImportMatch = content.match(/import\s+{([^}]+)}\s+from\s+['"]bun:test['"]/);
    
    if (bunImportMatch) {
      const imports = bunImportMatch[1]
        .split(',')
        .map(i => i.trim())
        .filter(i => i && !i.includes('expect'))
      
      // Replace beforeAll/afterAll with before/after
      const nodeImports = imports.map(imp => {
        if (imp === 'beforeAll') return 'before'
        if (imp === 'afterAll') return 'after'
        return imp
      })
      
      // Build new import statement
      let newImports = `import { ${nodeImports.join(', ')} } from 'node:test'`
      
      // Check if expect was imported
      if (bunImportMatch[1].includes('expect')) {
        newImports += `\nimport { expect, expectAsyncNotToThrow, expectAsyncToThrow } from '../../helpers/assertions.js'`
      }
      
      content = content.replace(
        /import\s+{[^}]+}\s+from\s+['"]bun:test['"]/,
        newImports
      )
      modified = true
    }
  }
  
  // 2. Add .js extensions to local imports (src/ and relative paths)
  const importRegex = /from\s+['"](\.\.[\/\\].*?|\.\/.*?)['"]/g
  content = content.replace(importRegex, (match, importPath) => {
    // Skip if already has extension
    if (importPath.endsWith('.js') || importPath.endsWith('.ts')) {
      return match
    }
    // Add .js extension
    return match.replace(importPath, importPath + '.js')
  })
  
  // Also handle src/ imports
  const srcImportRegex = /from\s+['"](\.\.[\/\\].*?src[\/\\].*?)['"]/g
  if (srcImportRegex.test(content)) {
    modified = true
  }
  
  // 3. Replace expect().not.toThrow() patterns with expectAsyncNotToThrow
  if (content.includes('await expect(async ()') && content.includes('.not.toThrow()')) {
    content = content.replace(
      /await\s+expect\(async\s+\(\)\s+=>\s+{([^}]+)}\)\.not\.toThrow\(\)/g,
      'await expectAsyncNotToThrow(async () => {$1})'
    )
    modified = true
  }
  
  // 4. Replace expect(() => ...).toThrow() with assert.throws
  if (content.includes('expect(() =>') && content.includes('.toThrow()')) {
    // This is more complex, might need manual review
    console.log(`  ⚠️  Contains expect().toThrow() - may need manual review`)
  }
  
  // 5. Replace beforeAll/afterAll in content (not just imports)
  if (content.includes('beforeAll(')) {
    content = content.replace(/\bbeforeAll\(/g, 'before(')
    modified = true
  }
  if (content.includes('afterAll(')) {
    content = content.replace(/\bafterAll\(/g, 'after(')
    modified = true
  }
  
  if (modified) {
    await fs.writeFile(filePath, content, 'utf-8')
    console.log(`  ✅ Migrated successfully`)
  } else {
    console.log(`  ℹ️  No changes needed`)
  }
}

async function main() {
  console.log('🔄 Migrating test files from Bun to Node.js test runner...\n')
  
  const testsDir = path.join(rootDir, 'tests')
  const testFiles = await findTestFiles(testsDir)
  
  console.log(`Found ${testFiles.length} test files\n`)
  
  for (const file of testFiles) {
    try {
      await migrateTestFile(file)
    } catch (error) {
      console.error(`  ❌ Error migrating ${file}:`, error.message)
    }
  }
  
  console.log('\n✨ Migration complete!')
  console.log('\n📝 Next steps:')
  console.log('  1. Review the changes with git diff')
  console.log('  2. Run: npm test')
  console.log('  3. Fix any remaining issues manually')
  console.log('  4. Update documentation')
}

main().catch(console.error)

