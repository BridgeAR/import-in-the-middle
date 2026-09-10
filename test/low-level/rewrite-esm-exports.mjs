// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { deepStrictEqual, strictEqual } from 'node:assert/strict'

import { canUseRequireCacheBridge, rewriteEsmExports } from '../../lib/rewrite-esm-exports.mjs'

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
    'greet:greet:native',
    'load:load:native',
    'iterate:iterate:native',
    'stream:stream:native',
    'Thing:Thing:native'
  ])
  strictEqual(
    compact(result.source),
    'const first = 1, second = 2 export function greet () {} export async function load () {} ' +
      'export function* iterate () {} export async function* stream () {} export class Thing {}'
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
  deepStrictEqual(plan(result), [`default:${local}:native`])
  strictEqual(compact(result.source).startsWith('export'), true)
}

{
  const result = rewriteEsmExports('export const value = 1\nexport default value')
  deepStrictEqual(plan(result), ['value:value:dual', 'default:value:dual'])
  strictEqual(compact(result.source), 'const value = 1')
}

{
  const result = rewriteEsmExports('export const $_A1 = 1')
  deepStrictEqual(plan(result), ['$_A1:$_A1:native'])
  strictEqual(compact(result.source), 'export let $_A1 = 1')
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
  deepStrictEqual(plan(result), ['value:value:native'])
  strictEqual(compact(result.source), 'export let value = 1; const label = "other"')
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
  strictEqual(result.exports[0].mode, 'dual', 'a possible reference uses a dual cell after the linear scan')
  strictEqual(result.exports[64].mode, 'native', 'an unrelated large-module export keeps its native cell')
  strictEqual(result.exports[65].mode, 'native', 'a large-module default keeps its native cell')
}

{
  const result = rewriteEsmExports('export const value = { get current () { return 1 } }')
  deepStrictEqual(plan(result), ['value:value:native'])
}

{
  const result = rewriteEsmExports('export const { first } = source')
  deepStrictEqual(plan(result), ['first:first:native'])
  strictEqual(compact(result.source), 'export let { first } = source')
}

{
  const result = rewriteEsmExports('export const { first, second } = source')
  deepStrictEqual(plan(result), ['first:first:dual', 'second:second:dual'])
  strictEqual(compact(result.source), 'const { first, second } = source')
}

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
  ['export const promise = import(specifier)', 'dynamic import'],
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
  ['export async function value () { await Promise.resolve() }', 'await token'],
  ['export const value = "await"', 'conservative await text'],
  ['const text = "export"', 'export text without export records'],
  ['const value = 1', 'module without exports']
]) {
  strictEqual(rewriteEsmExports(source), undefined, `${message} falls back`)
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
