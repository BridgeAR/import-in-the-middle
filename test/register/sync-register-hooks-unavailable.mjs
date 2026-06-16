// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// Not version-gated on purpose: this asserts the error path that only the Node
// versions without module.registerHooks (< 22.15 / 23.0-23.4) can reach. On
// newer Node the success path is covered by the sync-register-hooks tests.

import * as nodeModule from 'node:module'
import { register } from '../../register-hooks.mjs'
import { throws } from 'node:assert'

if (typeof nodeModule.registerHooks === 'function') {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: module.registerHooks is available`)
  process.exit(0)
}

throws(() => register(), { message: /module\.registerHooks/ })
