// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createHook } from '../../create-hook.mjs'
import {
  canRewriteEsmExportsInPlace,
  canUseRequireCacheBridge,
  rewriteEsmExports
} from '../../lib/rewrite-esm-exports.mjs'

const require = createRequire(import.meta.url)
const registerPath = fileURLToPath(new URL('../../lib/register.js', import.meta.url))
require(registerPath)

const meta = { url: new URL('../../register-hooks.mjs', import.meta.url).href }
const hooks = createHook(meta, rewriteEsmExports, canUseRequireCacheBridge, canRewriteEsmExportsInPlace)
const iitmGlobal = globalThis[Symbol.for('import-in-the-middle')]
const bridge = iitmGlobal[`${registerPath}:cache-bridge`]

strictEqual(bridge.begin('node:fs', {}), undefined, 'non-file modules do not enter require.cache')
strictEqual(bridge.begin('file:///%zz', {}), undefined, 'malformed file URLs do not enter require.cache')
strictEqual(
  bridge.begin(pathToFileURL(registerPath).href, {}),
  undefined,
  'an existing require.cache entry is not replaced'
)

const temporaryPath = fileURLToPath(new URL('./temporary-cache-entry.mjs', import.meta.url))
const temporaryUrl = pathToFileURL(temporaryPath).href
const cachedModule = bridge.begin(temporaryUrl, { value: 1 })
strictEqual(require.cache[temporaryPath], cachedModule)
bridge.end(cachedModule)
strictEqual(require.cache[temporaryPath], undefined, 'the temporary cache entry is removed')

const result = { url: 'file:///target.mjs', format: 'module' }
strictEqual(
  hooks.resolveSync('./target.mjs', { parentURL: meta.url, conditions: ['import'] }, () => result),
  result,
  'the loader does not wrap its own dependency'
)

const invalidUrl = 'file:///%zz'
strictEqual(
  hooks.resolveSync('invalid-url', { parentURL: 'file:///app.mjs', conditions: ['import'] }, () => ({
    url: invalidUrl,
    format: 'module'
  })).url,
  invalidUrl,
  'an invalid file URL cannot be looked up in require.cache'
)

const originalUrl = new URL('file:///target.mjs')
originalUrl.searchParams.set('iitm', 'original')
deepStrictEqual(
  hooks.resolveSync(originalUrl.href, { parentURL: 'file:///app.mjs', conditions: ['import'] }, () => result),
  { url: originalUrl.href, shortCircuit: true, format: 'module' },
  'the internal original URL keeps its module identity'
)
const taggedUrl = new URL('file:///target.mjs')
taggedUrl.searchParams.set('iitm', 'true')
let resolvedSpecifier
hooks.resolveSync(taggedUrl.href, { parentURL: 'file:///app.mjs', conditions: ['import'] }, (specifier) => {
  resolvedSpecifier = specifier
  return result
})
strictEqual(resolvedSpecifier, 'file:///target.mjs', 'ordinary IITM markers are removed before resolution')
const nonSourceResult = { format: 'module', source: null }
strictEqual(
  hooks.loadSync(originalUrl.href, { format: 'module' }, () => nonSourceResult),
  nonSourceResult,
  'an original module without source passes through unchanged'
)

const hashbangResult = hooks.loadSync(originalUrl.href, { format: 'module' }, () => ({
  format: 'module',
  source: '#!node'
}))
strictEqual(hashbangResult.source, '#!node\n//# sourceURL=file:///target.mjs')
for (const lineBreak of ['\r', '\r\n']) {
  const source = `#!node${lineBreak}export const value = 1\n`
  const result = hooks.loadSync(originalUrl.href, { format: 'module' }, () => ({ format: 'module', source }))
  strictEqual(result.source, `${source}\n//# sourceURL=file:///target.mjs`)
}

const sharedUrl = 'file:///shared-format.mjs'
strictEqual(
  hooks.resolveSync('shared-format', { parentURL: 'file:///app.cjs', conditions: ['require'] }, () => ({
    url: sharedUrl,
    format: 'commonjs'
  })).url,
  sharedUrl
)
strictEqual(
  hooks.resolveSync('shared-format', { parentURL: 'file:///app.mjs', conditions: ['import'] }, () => ({
    url: sharedUrl,
    format: 'module'
  })).url,
  sharedUrl,
  'a CommonJS require does not disable a later canonical ESM import'
)
