'use strict'

import { strictEqual, doesNotThrow } from 'assert'
import { createRequire } from 'module'

// get-esm-exports.mjs must stay a synchronous ES module. A top-level await in
// it (e.g. awaiting the parser selection) turns it — and every module that
// pulls it in, including create-hook.mjs and the register-hooks entry a
// CommonJS preloader require()s to install the synchronous loader — into an
// async module, so require() throws ERR_REQUIRE_ASYNC_MODULE and the sync
// loader cannot be registered from a require() context.
const require = createRequire(import.meta.url)

let getEsmExports
doesNotThrow(() => {
  getEsmExports = require('../../lib/get-esm-exports.mjs').default
}, 'require() of get-esm-exports.mjs must not throw ERR_REQUIRE_ASYNC_MODULE')

const exportNames = getEsmExports('export const a = 1\nexport * from "./b.mjs"')
strictEqual(exportNames.has('a'), true)
strictEqual(exportNames.has('* from ./b.mjs'), true)
