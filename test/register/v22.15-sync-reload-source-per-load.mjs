// Synchronous (`module.registerHooks`) counterpart to
// test/other/v18.19-reload-source-per-load.mjs: an inner sync loader returns
// different source on each `load()` of the same module. The in-place path uses
// its single load as the execution source. Wrapper fallback still scans once
// and executes the second source.

import * as nodeModule from 'node:module'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'
import Hook from '../../index.js'
import { strictEqual } from 'node:assert/strict'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

const RELOAD_URL = new URL('file:///virtual/sync-reload-source-per-load.mjs').href
const WRAPPER_URL = new URL('file:///virtual/sync-reload-source-wrapper.mjs').href
let loadCount = 0
let wrapperLoadCount = 0

nodeModule.registerHooks({
  /**
   * @param {string} specifier The requested module specifier.
   * @param {object} context The resolver context.
   * @param {(specifier: string, context: object) => object} nextResolve The next resolver hook.
   */
  resolve (specifier, context, nextResolve) {
    if (specifier === 'virtual-sync-reload-source-per-load' || specifier === RELOAD_URL) {
      return { url: RELOAD_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'virtual-sync-reload-source-wrapper' || specifier === WRAPPER_URL) {
      return { url: WRAPPER_URL, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  /**
   * @param {string} url The requested module URL.
   * @param {object} context The loader context.
   * @param {(url: string, context: object) => object} nextLoad The next loader hook.
   */
  load (url, context, nextLoad) {
    if (url === RELOAD_URL) {
      loadCount += 1
      return { format: 'module', source: `export const value = ${loadCount}\n`, shortCircuit: true }
    }
    if (url === WRAPPER_URL) {
      wrapperLoadCount += 1
      return { format: 'module', source: `export let value = ${wrapperLoadCount}\n`, shortCircuit: true }
    }
    return nextLoad(url, context)
  }
})

register()

let hookedValue
let wrapperHookedValue

/**
 * @param {import('../../index').Namespace} exports The module exports.
 * @param {string} name The resolved module name.
 */
const hook = (exports, name) => {
  if (name.endsWith('sync-reload-source-per-load.mjs')) {
    hookedValue = exports.value
  } else if (name.endsWith('sync-reload-source-wrapper.mjs')) {
    wrapperHookedValue = exports.value
  }
}
// eslint-disable-next-line no-new
new Hook(hook)

// @ts-expect-error - resolved by the in-process loader above
const namespace = await import('virtual-sync-reload-source-per-load')

strictEqual(namespace.value, 1, 'the in-place path executes its only loaded source')
strictEqual(hookedValue, 1, 'the hook observes the in-place execution source')
strictEqual(loadCount, 1, 'the in-place path does not repeat downstream loader work')

// @ts-expect-error - resolved by the in-process loader above
const wrapperNamespace = await import('virtual-sync-reload-source-wrapper')
strictEqual(wrapperNamespace.value, 2, 'wrapper fallback executes the source returned by the second load')
strictEqual(wrapperHookedValue, 2, 'the hook observes the wrapper execution source')
strictEqual(wrapperLoadCount, 2, 'wrapper fallback retains the scan and execution loads')

console.log('✅ module.registerHooks loads in-place modules once and preserves wrapper reloads')
