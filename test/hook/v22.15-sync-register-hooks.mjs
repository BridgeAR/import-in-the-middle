// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { spawnSync } from 'child_process'
import * as nodeModule from 'module'
import { strictEqual } from 'assert'
import { fileURLToPath } from 'url'

// `module.registerHooks` exists on >= 22.15 and >= 24, but not on 23.0-23.4.
// The filename gate only covers the major/minor floor, so guard at runtime too.
if (typeof nodeModule.registerHooks !== 'function') {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: module.registerHooks is unavailable`)
  process.exit(0)
}

const entry = fileURLToPath(new URL('../fixtures/sync-register-hooks-entry.mjs', import.meta.url))

const result = spawnSync(process.execPath, ['--no-warnings', entry], {
  encoding: 'utf8',
  // The test runner installs its own off-thread loader via NODE_OPTIONS. Run
  // the child with only the synchronous hooks the fixture registers itself.
  env: { ...process.env, NODE_OPTIONS: '' }
})

strictEqual(result.signal, null, result.stderr || result.stdout)
strictEqual(result.status, 0, result.stderr || result.stdout)
