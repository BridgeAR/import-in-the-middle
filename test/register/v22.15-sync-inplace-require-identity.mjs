// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { strictEqual, throws } from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'

import Hook from '../../index.js'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

const IMPORT_FIRST_URL = 'file:///virtual/iitm-import-first-identity.mjs'
const CYCLE_A_URL = 'file:///virtual/iitm-cycle-a.mjs'
const CYCLE_B_URL = 'file:///virtual/iitm-cycle-b.mjs'
const PREIMPORTED_URL = 'file:///virtual/iitm-preimported-identity.mjs'
const PRELOADED_URL = 'iitm-memory:preloaded-identity'
const REQUIRE_FIRST_URL = 'file:///virtual/iitm-require-first-identity.mjs'
const REENTRANT_URL = 'file:///virtual/iitm-reentrant-identity.mjs'
const TLA_URL = 'file:///virtual/iitm-tla-identity.mjs'

registerHooks({
  resolve (specifier, context, nextResolve) {
    if (specifier === 'iitm-import-first' || specifier === IMPORT_FIRST_URL) {
      return { url: IMPORT_FIRST_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-cycle-a' || specifier === CYCLE_A_URL) {
      return { url: CYCLE_A_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === './iitm-cycle-b.mjs' || specifier === CYCLE_B_URL) {
      return { url: CYCLE_B_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-preimported' || specifier === PREIMPORTED_URL) {
      return { url: PREIMPORTED_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-preloaded' || specifier === PRELOADED_URL) {
      return { url: PRELOADED_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-require-first' || specifier === REQUIRE_FIRST_URL) {
      return { url: REQUIRE_FIRST_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-reentrant' || specifier === REENTRANT_URL) {
      return { url: REENTRANT_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-tla' || specifier === TLA_URL) {
      return { url: TLA_URL, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load (url, context, nextLoad) {
    if (url === CYCLE_A_URL) {
      return {
        format: 'module',
        source: 'import { callA } from "./iitm-cycle-b.mjs"\n' +
          'export function a () { return "a" }\nexport const value = callA()\n',
        shortCircuit: true
      }
    }
    if (url === CYCLE_B_URL) {
      return {
        format: 'module',
        source: 'import { a } from "iitm-cycle-a"\nexport function callA () { return a() }\n',
        shortCircuit: true
      }
    }
    if (url === PREIMPORTED_URL) {
      return {
        format: 'module',
        source: 'globalThis.__iitmPreimported = (globalThis.__iitmPreimported ?? 0) + 1\n' +
          'export const instance = {}\nexport default instance\nexport const evaluations = globalThis.__iitmPreimported\n',
        shortCircuit: true
      }
    }
    if (url === PRELOADED_URL) {
      return {
        format: 'module',
        source: 'globalThis.__iitmPreloaded = (globalThis.__iitmPreloaded ?? 0) + 1\n' +
          'export const instance = {}\nexport const evaluations = globalThis.__iitmPreloaded\n',
        shortCircuit: true
      }
    }
    if (url === TLA_URL) {
      return {
        format: 'module',
        source: 'await Promise.resolve()\nexport const value = 42\n',
        shortCircuit: true
      }
    }
    if (url === REENTRANT_URL) {
      return {
        format: 'module',
        source: 'const instance = {}\nexport { instance }\nexport default instance\nexport const url = import.meta.url\n',
        shortCircuit: true
      }
    }
    if (url === IMPORT_FIRST_URL || url === REQUIRE_FIRST_URL) {
      return {
        format: 'module',
        source: 'export const instance = {}\nexport default instance\n',
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})

const require = createRequire(import.meta.url)
const preloaded = require('../fixtures/inplace-preloaded.mjs')
const virtualPreloaded = require('iitm-preloaded')
const preimported = await import('iitm-preimported')

register()

let reentrantSame
let importFirstHooks = 0
let tlaRequireError
// eslint-disable-next-line no-new
new Hook((exports, name) => {
  if (name === '/virtual/iitm-reentrant-identity.mjs') {
    reentrantSame = require('iitm-reentrant').instance === exports.instance
  } else if (name === '/virtual/iitm-import-first-identity.mjs') {
    importFirstHooks++
  } else if (name === '/virtual/iitm-tla-identity.mjs') {
    try {
      require('iitm-tla')
    } catch (error) {
      tlaRequireError = error.code
    }
  }
})

const importedFirst = await import('iitm-import-first')
const requiredSecond = require('iitm-import-first')
strictEqual(importedFirst.instance, requiredSecond.instance, 'require reuses an in-place import')
strictEqual(importedFirst.default, requiredSecond.default, 'require preserves the default export')
strictEqual(Object.isExtensible(requiredSecond), false, 'require returns a native non-extensible namespace')
strictEqual(Object.getOwnPropertyDescriptor(requiredSecond, 'instance').configurable, false)
throws(() => { requiredSecond.instance = {} }, TypeError, 'the required namespace remains read-only')
const importedThird = await import('iitm-import-first')
strictEqual(importedThird, importedFirst, 'a later import retains the first namespace')
strictEqual(importFirstHooks, 1, 'import then require does not register the Hook twice')

const requiredFirst = require('iitm-require-first')
const importedSecond = await import('iitm-require-first')
strictEqual(importedSecond.instance, requiredFirst.instance, 'an import reuses a module required first')
strictEqual(importedSecond.default, requiredFirst.default, 'the fallback wrapper preserves the default export')

const importedPreloaded = await import('../fixtures/inplace-preloaded.mjs')
strictEqual(importedPreloaded.instance, preloaded.instance, 'an import reuses a module required before registration')
strictEqual(importedPreloaded.default, preloaded.default, 'a preloaded module preserves its default export identity')
strictEqual(importedPreloaded.evaluations, 1, 'a preloaded module is not evaluated again')

const importedVirtualPreloaded = await import('iitm-preloaded')
strictEqual(importedVirtualPreloaded.instance, virtualPreloaded.instance, 'a non-file preload keeps its export identity')
strictEqual(importedVirtualPreloaded.evaluations, 1, 'a non-file preload is not evaluated again')

const importedAgain = await import('iitm-preimported')
strictEqual(importedAgain, preimported, 'registration preserves a module imported before it ran')
strictEqual(importedAgain.instance, preimported.instance, 'a pre-imported export keeps its identity')
strictEqual(importedAgain.evaluations, 1, 'a pre-imported module is not evaluated again')

const cycle = await import('iitm-cycle-a')
strictEqual(cycle.value, 'a', 'a wrapped dependency cycle observes initialized original bindings')

const reentrant = await import('iitm-reentrant')
strictEqual(reentrantSame, true, 'a Hook can require the module while the in-place binding is registered')
strictEqual(reentrant.instance, reentrant.default)
strictEqual(reentrant.url, REENTRANT_URL, 'the bridged fallback preserves import.meta.url')

await import('iitm-tla')
strictEqual(tlaRequireError, 'ERR_REQUIRE_ASYNC_MODULE', 'a Hook cannot bypass top-level-await require semantics')
throws(
  () => require('iitm-tla'),
  { code: 'ERR_REQUIRE_ASYNC_MODULE' },
  'require preserves the native top-level-await error'
)

console.log('✅ sync in-place transform preserves require identity before, during, and after import')
