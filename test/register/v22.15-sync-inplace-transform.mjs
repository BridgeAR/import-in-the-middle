// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// Exercises the synchronous in-place export transform: an ESM module's own
// source is rewritten so consumers import it directly, with no
// generated wrapper module. The transform handles the shapes a single
// es-module-lexer pass can classify: inline `const` / `let` / `var` / `function`
// / `class`, an `export async function`, and a named default function. Immutable
// declarations use dual cells, while mutable declarations retain their native
// live cells so later assignments remain visible.
import { match, ok, strictEqual } from 'node:assert/strict'
import * as nodeModule from 'node:module'

import Hook from '../../index.js'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

const STRING_SOURCE_URL = 'file:///virtual/iitm-string-source.mjs'
const TYPED_SOURCE_URL = 'file:///virtual/iitm-typed-source.mjs'
const COMMENT_DEFAULT_URL = 'file:///virtual/iitm-comment-default.mjs'
const typedBytes = Uint8Array.from(Buffer.from('xxexport const value = 41\nzz'))
nodeModule.registerHooks({
  /**
   * @param {string} specifier The requested module specifier.
   * @param {object} context The resolver context.
   * @param {(specifier: string, context: object) => object} nextResolve The next resolver hook.
   */
  resolve (specifier, context, nextResolve) {
    if (specifier === 'iitm-string-source' || specifier === STRING_SOURCE_URL) {
      return { url: STRING_SOURCE_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-typed-source' || specifier === TYPED_SOURCE_URL) {
      return { url: TYPED_SOURCE_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'iitm-comment-default' || specifier === COMMENT_DEFAULT_URL) {
      return { url: COMMENT_DEFAULT_URL, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  /**
   * @param {string} url The requested module URL.
   * @param {object} context The loader context.
   * @param {(url: string, context: object) => object} nextLoad The next loader hook.
   */
  load (url, context, nextLoad) {
    if (url === STRING_SOURCE_URL) {
      return { format: 'module', source: 'export const value = 1\n', shortCircuit: true }
    }
    if (url === TYPED_SOURCE_URL) {
      return {
        format: 'module',
        source: new Uint16Array(typedBytes.buffer, 2, (typedBytes.byteLength - 4) / 2),
        shortCircuit: true
      }
    }
    if (url === COMMENT_DEFAULT_URL) {
      return {
        format: 'module',
        source: 'export/**/default function value () { return 42 }\n',
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})

register()

let hooked = false
let stringSourceHooked = false
let importMetaHooked = false
let liveBindingsHooked = false
let typedSourceHooked = false
let commentDefaultHooked = false
/**
 * @param {import('../../index').Namespace} exports The module exports.
 * @param {string} name The resolved module name.
 */
const hook = (exports, name) => {
  if (/inplace-fastpath\.mjs/.test(name)) {
    hooked = true
    exports.foo += 15
  } else if (name === '/virtual/iitm-string-source.mjs') {
    stringSourceHooked = true
    exports.value += 1
  } else if (/inplace-import-meta\.mjs/.test(name)) {
    importMetaHooked = true
  } else if (/inplace-live-bindings\.mjs/.test(name)) {
    liveBindingsHooked = true
    exports.state = 'hooked'
  } else if (name === '/virtual/iitm-typed-source.mjs') {
    typedSourceHooked = true
    exports.value += 1
  } else if (name === '/virtual/iitm-comment-default.mjs') {
    commentDefaultHooked = true
  }
}
// eslint-disable-next-line no-new
new Hook(hook)

const namespace = await import('../fixtures/inplace-fastpath.mjs')

ok(hooked, 'in-place transform runs the hook for inplace-fastpath.mjs')

// The transform injects `__iitm*` cells and a writer into the module scope.
// None may leak into the namespace, or
// Object.keys / for-in consumers (dd-trace's Hook iterates exports) would see and
// wrap them.
strictEqual(
  Object.keys(namespace).sort().join(','),
  'Counter,default,foo,greet,load',
  'only the user exports are enumerable; injected identifiers do not leak'
)

strictEqual(namespace.foo, 57, 'hook-mutated named export is visible to importers')
strictEqual(typeof namespace.greet, 'function', 'other named exports are preserved')
strictEqual(typeof namespace.Counter, 'function', 'named class export is preserved')
strictEqual(new namespace.Counter().increment(), 1, 'class export is usable')
strictEqual(namespace.load.constructor.name, 'AsyncFunction', 'the async function export keeps its async-ness')

strictEqual(typeof namespace.default, 'function', 'the named default function is present')

// Dual-cell: the module's own references resolve to the module's own binding,
// not the Hook-overridden external cell, so internal reads see the ORIGINAL
// value. This matches the wrapper and is the correctness fix over a single-cell
// rewrite.
strictEqual(namespace.greet(), 'hi 42', 'internal reference is unaffected by the override (matches wrapper)')
strictEqual(namespace.default(), 'hi 42', 'the default function reads the module-local foo')

const stringSource = await import('iitm-string-source')
ok(stringSourceHooked)
strictEqual(stringSource.value, 2)

const typedSource = await import('iitm-typed-source')
ok(typedSourceHooked)
strictEqual(typedSource.value, 42, 'typed-array source respects its byte offset and length')

const commentDefault = await import('iitm-comment-default')
ok(commentDefaultHooked)
strictEqual(commentDefault.default(), 42, 'comments before default fall back to the wrapper')

let stack
const importMeta = await import('../fixtures/inplace-import-meta.mjs')
ok(importMetaHooked)
strictEqual(importMeta.url, new URL('../fixtures/inplace-import-meta.mjs', import.meta.url).href)
try {
  importMeta.boom()
} catch (error) {
  stack = error.stack
}
match(stack, /inplace-import-meta\.mjs:9:9\b/, 'wrapper fallback hides its internal URL and keeps source lines')

const liveBindings = await import('../fixtures/inplace-live-bindings.mjs')
ok(liveBindingsHooked, 'direct mutable exports use the in-place transform')
strictEqual(liveBindings.state, 'hooked', 'Hook writes update the native let binding')
strictEqual(liveBindings.readState(), 'hooked', 'internal reads observe the Hook override')
strictEqual(liveBindings.Late, undefined, 'an uninitialized var export starts undefined')
liveBindings.updateState('updated')
strictEqual(liveBindings.state, 'updated', 'later module writes remain visible to importers')
liveBindings.initializeLate()
strictEqual(liveBindings.Late.name, 'Late', 'later var initialization remains visible to importers')
const liveConsumer = await import('../fixtures/inplace-live-consumer.mjs')
strictEqual(liveConsumer.Sub.name, 'Sub', 'a synchronous class heritage read sees the initialized var export')

// The rewritten body comes first and byte-for-byte keeps the user's line
// positions, so stack traces point at the original lines (the wrapper leaves the
// real module untouched, and the transform must not regress that).
const throwing = await import('../fixtures/inplace-throws.mjs')
try {
  throwing.boom()
} catch (error) {
  stack = error.stack
}
// The `?iitm=true` query is still present on the sync path today (the wiring that
// removes the indirection is separate); what matters here is the line:col.
match(stack, /inplace-throws\.mjs(?:\?iitm=true)?:4:/, 'stack trace keeps the original source line after the in-place rewrite')

const columnThrowing = await import('../fixtures/inplace-stack-column.mjs')
try {
  columnThrowing.boom()
} catch (error) {
  stack = error.stack
}
match(
  stack,
  /inplace-stack-column\.mjs(?:\?iitm=true)?:1:33\b/,
  'stack trace keeps the original source column after the in-place rewrite'
)

console.log('✅ sync in-place transform: direct declarations preserve dual-cell parity')
