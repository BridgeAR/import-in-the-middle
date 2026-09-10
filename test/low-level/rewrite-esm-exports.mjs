// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { deepStrictEqual, strictEqual } from 'node:assert/strict'

import {
  canRewriteEsmExportsInPlace,
  canUseRequireCacheBridge,
  rewriteEsmExports
} from '../../lib/rewrite-esm-exports.mjs'
import { parseEsm } from '../../lib/get-esm-exports.mjs'

/**
 * @param {{ exports: Array<{ name: string, local: string, mode: string }> }} result A successful rewrite.
 * @returns {string[]} Compact export plan entries.
 */
function plan (result) {
  const entries = []
  for (const { name, local, mode } of result.exports) {
    entries.push(`${name}:${local}:${mode}`)
  }
  return entries
}

/**
 * @param {string} source Rewritten module source.
 * @returns {string} Source without insignificant whitespace.
 */
function compact (source) {
  return source.replace(/\s+/g, ' ').trim()
}

{
  const result = rewriteEsmExports([
    'export const first = 1, second = 2',
    'export function greet () {}',
    'export async function load () {}',
    'export function* iterate () {}',
    'export async function* stream () {}',
    'export class Thing {}'
  ].join('\n'))

  deepStrictEqual(plan(result), [
    'first:first:dual',
    'second:second:dual',
    'greet:greet:dual',
    'load:load:dual',
    'iterate:iterate:dual',
    'stream:stream:dual',
    'Thing:Thing:dual'
  ])
  strictEqual(
    compact(result.source),
    'const first = 1, second = 2 function greet () {} async function load () {} ' +
      'function* iterate () {} async function* stream () {} class Thing {}',
    'immutable declarations retain their original binding semantics'
  )
}

{
  const result = rewriteEsmExports([
    'export default function main () {}',
    'export default async function other () {}'
  ].join('\n'))

  strictEqual(result, undefined, 'duplicate default names fall back')
}

for (const [source, local] of [
  ['export default function main () {}', 'main'],
  ['export default class Main {}', 'Main'],
  ['export default async function main () {}', 'main'],
  ['export default function* main () {}', 'main'],
  ['export default async function* main () {}', 'main']
]) {
  const result = rewriteEsmExports(source)
  deepStrictEqual(plan(result), [`default:${local}:dual`])
  strictEqual(compact(result.source).startsWith('export'), false)
}

{
  const result = rewriteEsmExports('export const value = 1\nexport default value')
  deepStrictEqual(plan(result), ['value:value:dual', 'default:value:dual'])
  strictEqual(compact(result.source), 'const value = 1')
}

{
  const result = rewriteEsmExports('export const $_A1 = 1')
  deepStrictEqual(plan(result), ['$_A1:$_A1:dual'])
  strictEqual(compact(result.source), 'const $_A1 = 1')
}

for (const source of [
  'export const value = 1; console.log(value)',
  'export function value () { return value }',
  'export default function value () { return value }',
  'export class Value { static current = Value }',
  'export const value = 1; eval("value")',
  'export const value = 1; console.log(\\u0076alue)',
  'export const value = 1, other = 2'
]) {
  const result = rewriteEsmExports(source)
  strictEqual(plan(result).every(entry => entry.endsWith(':dual')), true, `${source} keeps dual cells`)
}

{
  const result = rewriteEsmExports('export const value = 1; const label = "other"')
  deepStrictEqual(plan(result), ['value:value:dual'])
  strictEqual(compact(result.source), 'const value = 1; const label = "other"')
}

{
  const result = rewriteEsmExports('export const value = 1; console.log(value)\nexport const other = 2')
  deepStrictEqual(plan(result), ['value:value:dual', 'other:other:dual'])
  strictEqual(compact(result.source), 'const value = 1; console.log(value) const other = 2')
}

{
  const result = rewriteEsmExports('export const url = import.meta.url')
  deepStrictEqual(plan(result), ['url:url:dual'])
  strictEqual(compact(result.source), 'const url = import.meta.url')
}

{
  const names = ['$value0', '_value1', 'vAlue2', 'value_3', 'value$4', 'Value5']
  const declarations = Array.from({ length: 65 }, (_, index) => {
    const name = names[index] ?? `value${index}`
    return `export const ${name} = ${index}`
  })
  declarations.push('export default function Main () {}')
  declarations.push('console.log($value0)')
  const result = rewriteEsmExports(declarations.join('\n'))
  strictEqual(result.exports.every(exported => exported.mode === 'dual'), true)
}

{
  const result = rewriteEsmExports('export const value = { get current () { return 1 } }')
  deepStrictEqual(plan(result), ['value:value:dual'])
}

strictEqual(rewriteEsmExports('export const { first } = source'), undefined)

strictEqual(rewriteEsmExports('export const { first, second } = source'), undefined)

{
  const result = rewriteEsmExports('export let state = 1, other = 2\nexport var Late')
  deepStrictEqual(plan(result), ['state:state:live', 'other:other:live', 'Late:Late:live'])
  strictEqual(compact(result.source), 'export let state = 1, other = 2 export var Late')
}

for (const [source, message] of [
  ['const value = 1; export default value', 'default alias of a detached const'],
  ['export default value; export const value = 1', 'default alias before const initialization'],
  ['export function value () {}; export default value', 'default alias of a function binding'],
  ['const value = 1; export { value }', 'immutable detached export'],
  ['let value = 1; export { value }', 'mutable detached export'],
  ['import value from "dep"; export { value }', 'import re-export'],
  ['import value from "dep"; export const own = value', 'bare static import'],
  ['import value from "./dep.mjs"; export const own = value', 'relative static import'],
  ['export { value } from "dep"', 'named re-export'],
  ['export * from "dep"', 'star re-export'],
  ['export * as ns from "dep"', 'namespace re-export'],
  ['export default value()', 'default call expression'],
  ['export default value.member', 'default member expression'],
  ['export default Value.member', 'default member expression with uppercase binding'],
  ['export default value | 0', 'default binary expression'],
  ['export default () => 1', 'anonymous default'],
  ['export default function () {}', 'anonymous default function'],
  ['export default function \\u0066 () {}', 'escaped default binding'],
  ['export/**/default function value () {}', 'comment before default'],
  ['const value = 1; export default value\nexport const next = 2', 'continued default statement'],
  ['const value = 1; export { value as "not-an-identifier" }', 'quoted export name'],
  ['export const \\u0076alue = 1', 'escaped inline binding'],
  ['export const value = 1; export function value () {}', 'duplicate direct name'],
  ['export const value = 1; export default value; export default value', 'duplicate default name'],
  ['export type { Value }', 'type-only export'],
  ['export enum Value {}', 'unsupported declaration'],
  ['export const promise = import(specifier)', 'immutable dynamic import'],
  ['const text = "export"', 'export text without export records'],
  ['const value = 1', 'module without exports']
]) {
  strictEqual(rewriteEsmExports(source), undefined, `${message} falls back`)
}

for (const source of [
  'export async function value () { await Promise.resolve() }',
  'export const value = "await"'
]) {
  strictEqual(plan(rewriteEsmExports(source)).every(entry => entry.endsWith(':dual')), true)
}

for (const source of [
  'export let value = 0\nvalue = 1',
  'export let value = 0\nvalue += 1',
  'export let value = 1\nvalue /= 2',
  'export let value = 0\nvalue++',
  'export let value = 1\nvalue--',
  'export let value = 0; ++value',
  'export let value = 1; --value',
  '#!node\nexport let value = 0\nvalue = 1'
]) {
  deepStrictEqual([...canRewriteEsmExportsInPlace(source)], ['value'], `${source} can be rewritten in place`)
}

{
  const source = 'export let first = 0, second = 0\nfirst = 1\nsecond += 1'
  const mutableExports = canRewriteEsmExportsInPlace(source)
  deepStrictEqual([...mutableExports], ['first', 'second'])
  deepStrictEqual(plan(rewriteEsmExports(source, undefined, mutableExports)), [
    'first:first:live',
    'second:second:live'
  ])
  strictEqual(rewriteEsmExports(source, undefined, new Set(['first'])), undefined)
}

{
  const prefix = 'export let value = 0\n'
  const suffix = 'value = 1'
  const source = prefix + ' '.repeat(4096 - prefix.length - suffix.length) + suffix
  deepStrictEqual([...canRewriteEsmExportsInPlace(source)], ['value'])
  strictEqual(canRewriteEsmExportsInPlace(`${source} `), undefined)
}

{
  const source = 'export const value = 1\nexport function read () { return value }'
  const mutableExports = canRewriteEsmExportsInPlace(source)
  deepStrictEqual([...mutableExports], [])
  deepStrictEqual(plan(rewriteEsmExports(source, undefined, mutableExports)), [
    'value:value:dual',
    'read:read:dual'
  ])
}

strictEqual(canRewriteEsmExportsInPlace('const value = 1'), undefined, 'a module without exports falls back')

for (const [source, message] of [
  ['export function read () { return import("./self.mjs") }', 'immutable export with a dynamic import'],
  ['export let value = 1\nconsole.log(value)', 'read without a write'],
  ['let value = 1\nexport { value }\nvalue = 2', 'detached export'],
  ['export let value = 1\nconst holder = { value: 2 }\nholder.value = 3', 'property write'],
  ['export let value = 1\nconst text = "value = 2"', 'string text'],
  ['export let value = 1\n// value = 2', 'comment text'],
  ['export let value = 1\nfunction update () { value = 2 }', 'function write'],
  ['export let value = 1\nif (ready) { value = 2 }', 'block write'],
  ['export let value = 1\nif (false) value = 2', 'unbraced conditional write'],
  ['export let value = 1\nfor (; false;) value = 2', 'unbraced for-loop write'],
  ['export let value = 1\nwhile (false) value = 2', 'unbraced while-loop write'],
  ['export let value = 1\nfalse ? value = 2 : 0', 'ternary write'],
  ['export let value = 1\nfalse && value++', 'short-circuit write'],
  ['export let value = 1\nvalue &&= 2', 'logical AND assignment'],
  ['export let value = 1\nvalue ||= 2', 'logical OR assignment'],
  ['export let value = 1\nvalue ??= 2', 'nullish assignment'],
  ['export let value = 1\nconst update = () => value = 2', 'arrow write'],
  ['export let value = 1\nif (ready)\n++value', 'conditional prefix update'],
  ['export let value = 1\nconst pattern = /value = 2/\nvalue = 2', 'regular expression'],
  ['export let value = 1\nconst text = `value = 2`\nvalue = 2', 'template text'],
  ['export let { value } = source\nvalue = 2', 'destructuring declaration'],
  ['export let value = 1\nfor (value of values) {}', 'for-of write'],
  ['export let value = 1\nvalue === 2', 'comparison'],
  ['export let value = 1\nenum Values { value = 2 }', 'TypeScript enum initializer']
]) {
  strictEqual(canRewriteEsmExportsInPlace(source), undefined, `${message} falls back`)
}

{
  const source = 'export let value = 1\nenum Values { value = 2 }\nvalue = 3'
  deepStrictEqual([...canRewriteEsmExportsInPlace(source)], ['value'])
}

for (const source of [
  'export let value = 1\n/* value = 2 */\nvalue = 3',
  'export let value = 1\nconst values = [value = 2]\nvalue = 3',
  'export let value = 1\nconst text = "value = \\"2\\""\nvalue = 3',
  'export async function load () {}\nexport let value = 1\nvalue = 2',
  '  ++value\nexport let value = 1'
]) {
  deepStrictEqual([...canRewriteEsmExportsInPlace(source)], ['value'])
}

{
  const validSource = 'export let value = 1\nvalue = 2'
  const parsed = parseEsm(validSource)
  strictEqual(canRewriteEsmExportsInPlace('export let value = 1\n"value = 2', parsed), undefined)
  strictEqual(canRewriteEsmExportsInPlace('export let value = 1\n/* value = 2', parsed), undefined)
}

{
  const source = 'import "dep"\nexport let value = 0\nvalue = 1'
  const mutableExports = canRewriteEsmExportsInPlace(source)
  deepStrictEqual([...mutableExports], ['value'])
  deepStrictEqual(plan(rewriteEsmExports(source, undefined, mutableExports)), ['value:value:live'])
  strictEqual(canUseRequireCacheBridge(source), false)
}

{
  const source = 'export const value = 1\nexport let state = 0\nstate = 1\nimport("./self.mjs")'
  const mutableExports = canRewriteEsmExportsInPlace(source)
  deepStrictEqual([...mutableExports], ['state'])
  strictEqual(rewriteEsmExports(source, undefined, mutableExports), undefined)
}

for (const [source, expected, message] of [
  ['export const value = 1', true, 'synchronous module'],
  ['export const url = import.meta.url', true, 'import.meta'],
  ['export const promise = import("dep")', true, 'dynamic import'],
  ['import "dep"; export const value = 1', false, 'static import'],
  ['await Promise.resolve(); export const value = 1', false, 'top-level await']
]) {
  strictEqual(canUseRequireCacheBridge(source), expected, `${message} cache bridge safety`)
}

console.log('✅ rewriteEsmExports: direct declaration exports and wrapper fallbacks')
