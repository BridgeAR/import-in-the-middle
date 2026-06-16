// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import * as module from 'module'
import { createHook } from './create-hook.mjs'

const hook = createHook(import.meta)

let registered = false

/**
 * Registers `import-in-the-middle` as a *synchronous*, in-thread loader hook via
 * [`module.registerHooks()`](https://nodejs.org/api/module.html#moduleregisterhooksoptions).
 *
 * Unlike `module.register('import-in-the-middle/hook.mjs', ...)`, which runs the
 * loader on a separate thread and pays an IPC round-trip per resolved module,
 * synchronous hooks run in the application thread. There is no message channel
 * to bridge, so `Hook()` registrations from the main `import-in-the-middle`
 * entry point are visible to the loader directly and no acknowledgement step is
 * required.
 *
 * Requires a Node.js version with `module.registerHooks()` (>= 22.15.0 / >= 24).
 *
 * ```js
 * import { register } from 'import-in-the-middle/register-hooks.mjs'
 * import { Hook } from 'import-in-the-middle'
 *
 * register({ include: ['package-i-want-to-include'] })
 *
 * Hook(['package-i-want-to-include'], (exported, name, baseDir) => {
 *   // Instrument the module
 * })
 * ```
 *
 * @param {object} [options]
 * @param {Array<string|RegExp>} [options.include] Only intercept these modules.
 * @param {Array<string|RegExp>} [options.exclude] Never intercept these modules.
 * @returns {void}
 */
export function register (options) {
  if (typeof module.registerHooks !== 'function') {
    throw new Error(
      "'import-in-the-middle' synchronous hooks require a Node.js version with " +
      "'module.registerHooks()' (>= 22.15.0 / >= 24.0.0)"
    )
  }

  if (registered) {
    process.emitWarning("'import-in-the-middle' synchronous hooks have already been registered")
    return
  }
  registered = true

  if (options) {
    hook.applyOptions(options)
  }

  module.registerHooks({ resolve: hook.resolveSync, load: hook.loadSync })
}
