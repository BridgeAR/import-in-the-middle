// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// Proves the in-place dual-cell transform matches the wrapper on the property
// that motivates dual-cell: when a Hook replaces an exported function, the
// module's own *internal* call to that export still runs the ORIGINAL function,
// not the Hook's replacement. A single-cell rewrite would reroute the internal
// call through the replacement and produce an extra layer (an extra span, in
// dd-trace terms). The wrapper never does that, and neither must the transform.

import { strictEqual } from 'node:assert/strict'

import Hook from '../../index.js'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

register()

let wrappedCalls = 0
let selfImportCalls = 0
let dynamicSelfImportCalls = 0
let packageSelfImportCalls = 0
/**
 * @param {import('../../index').Namespace} exports The module exports.
 * @param {string} name The resolved module name.
 */
const hook = (exports, name) => {
  if (/inplace-internal-call\.mjs/.test(name)) {
    const original = exports.connect
    exports.connect = function connect () {
      wrappedCalls += 1
      return original() + ':wrapped'
    }
  } else if (/inplace-self-import\.mjs/.test(name)) {
    const original = exports.connect
    exports.connect = function connect () {
      selfImportCalls += 1
      return original() + ':wrapped'
    }
  } else if (/inplace-self-dynamic\.mjs/.test(name)) {
    const original = exports.connect
    exports.connect = function connect () {
      dynamicSelfImportCalls += 1
      return original() + ':wrapped'
    }
  } else if (/inplace-self-package\/index\.mjs/.test(name)) {
    const original = exports.connect
    exports.connect = function connect () {
      packageSelfImportCalls += 1
      return original() + ':wrapped'
    }
  }
}
// eslint-disable-next-line no-new
new Hook(hook)

const namespace = await import('../fixtures/inplace-internal-call.mjs')

// An importer calling the export directly gets the Hook's wrapped version.
strictEqual(namespace.connect(), 'connected:wrapped', 'importer sees the Hook-wrapped export')
strictEqual(wrappedCalls, 1, 'the wrapped connect ran once for the external call')

// query() calls the module's own `connect` internally. Under dual-cell that
// internal reference resolves to the module's own original binding, so the
// wrapped version does NOT run again — exactly as with the wrapper.
strictEqual(namespace.query(), 'connected:queried', 'internal call runs the original connect (wrapper parity)')
strictEqual(wrappedCalls, 1, 'internal call did not re-enter the Hook wrapper (no extra span)')

const selfImport = await import('../fixtures/inplace-self-import.mjs')
strictEqual(selfImport.connect(), 'connected:wrapped', 'an importer sees the wrapped self-import fixture')
strictEqual(selfImportCalls, 1)
strictEqual(selfImport.query(), 'connected:queried', 'a module self-import keeps wrapper semantics')
strictEqual(selfImportCalls, 1, 'the self-import does not re-enter the Hook wrapper')

const dynamicSelfImport = await import('../fixtures/inplace-self-dynamic.mjs')
strictEqual(dynamicSelfImport.connect(), 'dynamic-connected:wrapped')
strictEqual(dynamicSelfImportCalls, 1)
strictEqual(await dynamicSelfImport.query(), 'dynamic-connected:queried')
strictEqual(dynamicSelfImportCalls, 1, 'the dynamic self-import does not re-enter the Hook wrapper')

const packageSelfImport = await import('../fixtures/inplace-self-package/index.mjs')
strictEqual(packageSelfImport.connect(), 'package-connected:wrapped')
strictEqual(packageSelfImportCalls, 1)
strictEqual(packageSelfImport.query(), 'package-connected:queried', 'a bare package self-import keeps wrapper semantics')
strictEqual(packageSelfImportCalls, 1)

console.log('✅ sync in-place transform: internal self-call runs the original export (dual-cell parity)')
