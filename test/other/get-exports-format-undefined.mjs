import { strictEqual, deepStrictEqual } from 'assert'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { getExports, hasModuleExportsCJSDefault } from '../../lib/get-exports.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const esmNoExportsPath = resolve(__dirname, '..', 'fixtures', 'side-effect-only.mjs')
const esmNoExportsUrl = pathToFileURL(esmNoExportsPath).href
const esmNoExportsSource = readFileSync(esmNoExportsPath, 'utf8')

const cjsNoNamedPath = resolve(__dirname, '..', 'fixtures', 'cjs-module-exports-no-named.js')
const cjsNoNamedUrl = pathToFileURL(cjsNoNamedPath).href
const cjsNoNamedSource = readFileSync(cjsNoNamedPath, 'utf8')

async function main () {
  // Case 1: format is missing, but source contains ESM syntax (static import).
  // Prefer keeping it as ESM even if there are no exports.
  {
    async function parentLoad (url) {
      strictEqual(url, esmNoExportsUrl)
      return { source: esmNoExportsSource, format: undefined }
    }

    const context = {}
    const exportsSet = await getExports(esmNoExportsUrl, context, parentLoad)
    deepStrictEqual([...exportsSet], [])
    strictEqual(context.format, undefined)
  }

  // Case 2: format is missing and source contains no ESM syntax. Fall back to CJS.
  {
    async function parentLoad (url) {
      strictEqual(url, cjsNoNamedUrl)
      return { source: cjsNoNamedSource, format: undefined }
    }

    const context = {}
    const exportsSet = await getExports(cjsNoNamedUrl, context, parentLoad)
    const expected = ['default']
    if (hasModuleExportsCJSDefault) expected.push('module.exports')
    deepStrictEqual([...exportsSet].sort(), expected.sort())
    strictEqual(context.format, 'commonjs')
  }
}

main().catch((err) => {
  // Ensure failures are treated as test failures on Node versions without top-level await.
  console.error(err)
  process.exitCode = 1
})
