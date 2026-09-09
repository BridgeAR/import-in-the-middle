import { strictEqual } from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { supportsSyncHooks } from '../../supports-sync-hooks.mjs'

if (!supportsSyncHooks()) {
  console.log(`Skipping ${process.env.IITM_TEST_FILE || import.meta.url}: synchronous hooks unsupported on this Node.js`)
  process.exit(0)
}

for (const order of ['ab', 'ba']) {
  const result = spawnSync(process.execPath, ['test/fixtures/sync-inplace-multiple-copies-app.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IITM_COPY_ORDER: order,
      NODE_OPTIONS: ''
    }
  })
  const output = `registration order ${order}\n${result.stderr || result.stdout}`
  strictEqual(result.signal, null, output)
  strictEqual(result.status, 0, output)
}
