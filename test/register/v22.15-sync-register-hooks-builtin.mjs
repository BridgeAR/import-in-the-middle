// Regression test: under the synchronous `module.registerHooks` loader, iitm's
// own internal `require()` for a builtin used to be intercepted by iitm's
// in-thread hooks and resolve to the half-built wrapper, so a hooked builtin
// lost all of its named exports and was wrapped repeatedly. `getBuiltinModule`
// now reads the native module directly. The off-thread `module.register`
// loader was never affected because its `require` runs unhooked on the loader
// thread.

import * as nodeModule from 'node:module'
import { register } from '../../register-hooks.mjs'
import Hook from '../../index.js'
import { ok, strictEqual } from 'node:assert'

if (typeof nodeModule.registerHooks !== 'function') {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: module.registerHooks is unavailable`)
  process.exit(0)
}

register()

let eventsHookCount = 0
let fsHookCount = 0

// eslint-disable-next-line no-new
new Hook(['events', 'fs'], (exports, name) => {
  if (name === 'events') eventsHookCount++
  if (name === 'fs') fsHookCount++
})

const events = await import('node:events')

// The hook must fire exactly once: the re-entrancy bug wrapped node:events
// three times, so it fired three times.
strictEqual(eventsHookCount, 1, 'events hook should fire exactly once')

// Named exports must survive wrapping, not collapse to default/module.exports.
strictEqual(typeof events.default, 'function', 'default (EventEmitter) should be present')
strictEqual(typeof events.EventEmitter, 'function', 'EventEmitter named export should be present')
strictEqual(typeof events.once, 'function', 'once named export should be present')
strictEqual(typeof events.on, 'function', 'on named export should be present')
ok('kMaxEventTargetListeners' in events, 'non-enumerable own property should be present')

const fs = await import('node:fs')
strictEqual(fsHookCount, 1, 'fs hook should fire exactly once')
strictEqual(typeof fs.readFileSync, 'function', 'readFileSync named export should be present')
strictEqual(typeof fs.existsSync, 'function', 'existsSync named export should be present')
strictEqual(typeof fs.default.readFileSync, 'function', 'default should carry the CJS exports')

// A bare builtin specifier (`require('crypto')`) resolves to a `node:`-prefixed
// URL that Node's synchronous resolver leaves without `format: 'builtin'`. The
// resolve hook has to restore it, otherwise the load hook treats `node:crypto`
// as a path and reads it from disk (ENOENT). Both spellings resolve to the same
// wrapper URL, so they must return the identical object.
const require = nodeModule.createRequire(import.meta.url)
for (const builtinName of ['crypto', 'http', 'events']) {
  strictEqual(
    require(builtinName),
    require(`node:${builtinName}`),
    `'${builtinName}' and 'node:${builtinName}' must wrap to the identical object`
  )
}

console.log('✅ module.registerHooks preserved builtin named exports and bare/node: identity')
