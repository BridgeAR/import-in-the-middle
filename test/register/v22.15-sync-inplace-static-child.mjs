// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// A module instrumented in place imports its dependencies with bare specifiers
// (its own rewritten source runs under the `?iitm=true` URL). Those statically
// imported children must still be instrumented and hookable: the resolve hook
// must not treat an in-place parent's `?iitm=true` URL as a reason to skip
// wrapping its children (as it does for a wrapper module, which only re-imports
// its own real self). Regression for the in-place path silently dropping child
// instrumentation even when shouldInclude matched the child.

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'

import Hook from '../../index.js'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

register()

const hookedNames = new Set()
/**
 * @param {import('../../index').Namespace} exports The module exports.
 * @param {string} name The resolved module name.
 */
const hook = (exports, name) => {
  if (/inplace-static-parent\.mjs/.test(name)) {
    hookedNames.add('parent')
  } else if (/inplace-static-child\.mjs/.test(name)) {
    hookedNames.add('child')
    exports.childName = () => 'HOOKED-CHILD'
  }
}
// eslint-disable-next-line no-new
new Hook(hook)

const namespace = await import('../fixtures/inplace-static-parent.mjs')

ok(hookedNames.has('parent'), 'the in-place parent is instrumented and hooked')
ok(hookedNames.has('child'), 'the statically-imported child is instrumented and hooked (not skipped)')

deepStrictEqual(
  Object.keys(namespace).sort(),
  ['parentValue', 'readChild'],
  'only the user exports are enumerable; injected identifiers do not leak'
)

// The parent imports the child through the child's iitm proxy, so a Hook
// override of the child export is visible to the parent's own use of it.
strictEqual(namespace.readChild(), 'HOOKED-CHILD', 'the parent sees the hooked child export through the proxy')

console.log('✅ sync in-place transform: statically-imported children are instrumented and hookable')
