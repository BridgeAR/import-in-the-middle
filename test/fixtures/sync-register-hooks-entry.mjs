// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// Child process for test/hook/v22.15-sync-register-hooks.mjs. It is run with a
// clean NODE_OPTIONS (no off-thread loader) so that the *only* thing wrapping
// modules is the synchronous `module.registerHooks` integration under test.

import { register } from '../../register-hooks.mjs'
import Hook from '../../index.js'
import { strictEqual, ok } from 'assert'

register()

let hookRan = false
const seen = []

// No module filter: match the fixture by file name, mirroring test/hook/static-import.mjs.
// eslint-disable-next-line no-new
new Hook((exports, name) => {
  seen.push(name)
  if (typeof name === 'string' && /something\.mjs/.test(name)) {
    hookRan = true
    exports.foo += 15
  }
})

// Static imports are hoisted and evaluated before `register()` runs, so the
// target has to be imported dynamically *after* the hook is installed.
const namespace = await import('./something.mjs')

ok(hookRan, `sync hook should have run for something.mjs (saw: ${seen.join(', ')})`)
strictEqual(namespace.foo, 57, 'hook-mutated named export should be visible through the wrapper')
strictEqual(typeof namespace.default, 'function', 'default export should be preserved')

console.log('✅ module.registerHooks wrapped and hooked something.mjs')
