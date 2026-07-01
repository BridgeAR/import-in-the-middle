'use strict'

import { strictEqual } from 'assert'
import { createRequire } from 'module'

// get-esm-exports.mjs must stay a synchronous ES module. A top-level await in
// it (e.g. awaiting the parser selection) turns it — and every module that
// pulls it in, including create-hook.mjs and the register-hooks entry a
// CommonJS preloader require()s to install the synchronous loader — into an
// async module, so require() throws ERR_REQUIRE_ASYNC_MODULE and the sync
// loader cannot be registered from a require() context.

// require(esm) only exists on >= 20.19 / >= 22.12; older Node throws
// ERR_REQUIRE_ESM for any ES module regardless of top-level await, so there is
// nothing to assert there. process.features.require_module is Node's own signal
// for the capability and is undefined on versions without it.
if (!process.features.require_module) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: require(esm) unsupported on this Node.js`)
  process.exit(0)
}

const require = createRequire(import.meta.url)

// A direct require() surfaces ERR_REQUIRE_ASYNC_MODULE as the test failure if
// the module regresses to a top-level await.
const getEsmExports = require('../../lib/get-esm-exports.mjs').default

const exportNames = getEsmExports('export const a = 1\nexport * from "./b.mjs"')
strictEqual(exportNames.has('a'), true)
strictEqual(exportNames.has('* from ./b.mjs'), true)
