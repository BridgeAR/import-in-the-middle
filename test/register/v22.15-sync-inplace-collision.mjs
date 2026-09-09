// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// A module that itself uses an identifier in iitm's injected `__iitm*` namespace
// must bail to the wrapper (whose scope is separate), not crash with a
// redeclaration. The export must still be usable and hookable through the
// wrapper path. This guards the collision detector in buildInPlaceSource.

import { ok, strictEqual } from 'node:assert/strict'

import Hook from '../../index.js'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

register()

let injectedHooked = false
let escapedHooked = false
let globalsHooked = false
/**
 * @param {import('../../index').Namespace} exports The module exports.
 * @param {string} name The resolved module name.
 */
const hook = (exports, name) => {
  if (/inplace-collision\.mjs/.test(name)) {
    injectedHooked = true
    exports.label = exports.label + ':hooked'
  } else if (/inplace-escaped-collision\.mjs/.test(name)) {
    escapedHooked = true
    exports.value += 1
  } else if (/inplace-global-collision\.mjs/.test(name)) {
    globalsHooked = true
    exports.label = exports.label + ':hooked'
  }
}
// eslint-disable-next-line no-new
new Hook(hook)

const namespace = await import('../fixtures/inplace-collision.mjs')

ok(injectedHooked, 'the collision fixture is still hooked (via the wrapper fallback)')
strictEqual(namespace.value(), 'user-owned', 'the module keeps its own __iitm-prefixed binding intact')
strictEqual(namespace.label, 'collision-fixture:hooked', 'the export is hookable through the wrapper')

const escaped = await import('../fixtures/inplace-escaped-collision.mjs')
ok(escapedHooked, 'the escaped collision fixture is still hooked through the wrapper fallback')
strictEqual(escaped.value, 43, 'an escaped __iitm-prefixed binding does not collide with generated declarations')

const globals = await import('../fixtures/inplace-global-collision.mjs')
ok(globalsHooked, 'the shadowed-globals fixture is still hooked through the wrapper fallback')
strictEqual(globals.value(), 'local-global:local-symbol')
strictEqual(globals.label, 'global-collision-fixture:hooked')

console.log('✅ sync in-place transform: injected-name collisions bail to the wrapper')
