import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = process.env.IITM_PACKAGE_ROOT ?? fileURLToPath(new URL('../..', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'iitm-copies-'))
const copies = [join(temporary, 'a'), join(temporary, 'b')]
const targets = [join(temporary, 'target-a.mjs'), join(temporary, 'target-b.mjs')]

/** @param {string} copy A package copy directory. */
async function loadPackage (copy) {
  const [{ register }, { default: Hook }] = await Promise.all([
    import(pathToFileURL(join(copy, 'register-hooks.mjs')).href),
    import(pathToFileURL(join(copy, 'index.js')).href)
  ])
  return { register, Hook }
}

/** @param {string} target A target module path. */
function importTarget (target) {
  return import(pathToFileURL(target).href)
}

/** @param {string} target A target module path. */
function resolveTarget (target) {
  return realpathSync(target)
}

try {
  for (const copy of copies) {
    mkdirSync(copy)
    for (const file of ['create-hook.mjs', 'index.js', 'package.json', 'register-hooks.mjs', 'supports-sync-hooks.mjs']) {
      cpSync(join(root, file), join(copy, file))
    }
    cpSync(join(root, 'lib'), join(copy, 'lib'), { recursive: true })
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }

  writeFileSync(targets[0], 'export const value = "a"\n')
  writeFileSync(targets[1], 'export const value = "b"\n')
  const resolvedTargets = targets.map(resolveTarget)

  const packages = await Promise.all(copies.map(loadPackage))

  const order = process.env.IITM_COPY_ORDER === 'ba' ? [1, 0] : [0, 1]
  for (const index of order) {
    packages[index].register({ include: [pathToFileURL(targets[index]).href] })
  }

  const hooked = []
  for (let index = 0; index < packages.length; index++) {
    const { Hook } = packages[index]
    /**
     * @param {import('../../index').Namespace} exports The module exports.
     * @param {string} name The resolved module name.
     */
    const hook = (exports, name) => {
      if (name === resolvedTargets[index]) {
        hooked.push(index)
        exports.value += '-hooked'
      }
    }
    // eslint-disable-next-line no-new
    new Hook(hook)
  }

  const namespaces = await Promise.all(targets.map(importTarget))
  deepStrictEqual(hooked.sort(), [0, 1])
  strictEqual(namespaces[0].value, 'a-hooked')
  strictEqual(namespaces[1].value, 'b-hooked')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
