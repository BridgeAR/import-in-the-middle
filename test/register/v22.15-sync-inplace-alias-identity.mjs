// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { ok, strictEqual } from 'node:assert/strict'
import * as nodeModule from 'node:module'

import Hook from '../../index.js'
import { register, supportsSyncHooks } from '../../register-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

const MODULE_URL = 'file:///virtual/iitm-alias-identity.mjs'
nodeModule.registerHooks({
  /**
   * @param {string} specifier The requested module specifier.
   * @param {object} context The resolver context.
   * @param {(specifier: string, context: object) => object} nextResolve The next resolver hook.
   */
  resolve (specifier, context, nextResolve) {
    if (specifier === 'included-iitm-alias' || specifier === 'excluded-iitm-alias' || specifier === MODULE_URL) {
      return { url: MODULE_URL, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  /**
   * @param {string} url The requested module URL.
   * @param {object} context The loader context.
   * @param {(url: string, context: object) => object} nextLoad The next loader hook.
   */
  load (url, context, nextLoad) {
    if (url === MODULE_URL) {
      return {
        format: 'module',
        source: `
process.iitmAliasIdentityCount = (process.iitmAliasIdentityCount ?? 0) + 1
export const value = process.iitmAliasIdentityCount
`,
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})

register({ include: ['included-iitm-alias'] })

let hooked = false
/**
 * @param {import('../../index').Namespace} exports The module exports.
 * @param {string} name The resolved module name.
 */
function hookAlias (exports, name) {
  if (name.endsWith('/iitm-alias-identity.mjs')) hooked = true
}
// eslint-disable-next-line no-new
new Hook(hookAlias)

const included = await import('included-iitm-alias')
const excluded = await import('excluded-iitm-alias')

ok(hooked, 'the included alias is hooked through the wrapper path')
strictEqual(included.value, 1, 'the included alias observes the first module evaluation')
strictEqual(excluded.value, 1, 'the excluded alias reuses the same module evaluation')
strictEqual(process.iitmAliasIdentityCount, 1, 'filtered aliases preserve singleton module identity')

delete process.iitmAliasIdentityCount

console.log('✅ sync in-place transform: filtered aliases preserve module identity')
