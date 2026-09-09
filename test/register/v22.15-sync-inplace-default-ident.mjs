// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// `export default <identifier>` can run in place when the identifier is an
// inline exported const. The default must remain callable and hookable without
// changing the named export's local binding.

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'

import Hook from '../../index.js'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

register()

let hooked = false
/**
 * @param {import('../../index').Namespace} exports The module exports.
 * @param {string} name The resolved module name.
 */
const hook = (exports, name) => {
  if (/inplace-default-ident\.mjs/.test(name)) {
    hooked = true
    exports.default = () => 'HOOKED'
  }
}
// eslint-disable-next-line no-new
new Hook(hook)

const namespace = await import('../fixtures/inplace-default-ident.mjs')

ok(hooked, 'the export-default-identifier module is instrumented in place and hooked')
deepStrictEqual(
  Object.keys(namespace).sort(),
  ['default', 'greet', 'version'],
  'default, the named function, and the renamed const are all enumerable'
)

strictEqual(namespace.version, '1.0.0', 'the renamed const export is present')
strictEqual(namespace.greet(), 'hi', 'the named export keeps the original binding (dual-cell parity)')
// The Hook overrode `default`; importers see the override, and it is independent
// of the named export the local also backs.
strictEqual(namespace.default(), 'HOOKED', 'the default export is hookable')
strictEqual(namespace.greet(), 'hi', 'overriding default does not change the named export')

console.log('✅ sync in-place transform: default alias of an exported const is instrumented')
