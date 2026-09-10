// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { strictEqual } from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createHook } from '../../create-hook.mjs'
import { canUseRequireCacheBridge, rewriteEsmExports } from '../../lib/rewrite-esm-exports.mjs'

const require = createRequire(import.meta.url)
const registerPath = fileURLToPath(new URL('../../lib/register.js', import.meta.url))
require(registerPath)

const meta = { url: new URL('../../register-hooks.mjs', import.meta.url).href }
const hooks = createHook(meta, rewriteEsmExports, canUseRequireCacheBridge)
const iitmGlobal = globalThis[Symbol.for('import-in-the-middle')]
const bridge = iitmGlobal[`${registerPath}:cache-bridge`]

strictEqual(bridge.begin('node:fs', {}), undefined, 'non-file modules do not enter require.cache')
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
const nonSourceResult = { format: 'module', source: null }
strictEqual(
  hooks.loadSync(originalUrl.href, { format: 'module' }, () => nonSourceResult),
  nonSourceResult,
  'an original module without source passes through unchanged'
)
