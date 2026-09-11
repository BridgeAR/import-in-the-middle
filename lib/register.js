// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

const importHooks = [] // TODO should this be a Set?
const binders = new WeakMap()
let legacySetters
let legacyGetters
let legacyProxyHandler
const specifiers = new Map()
const toHook = []
const iitmGlobal = globalThis[Symbol.for('import-in-the-middle')] ??= Object.create(null)
const cacheBridgeKey = `${__filename}:cache-bridge`

/**
 * @param {object} source The module namespace.
 * @param {string | symbol} name The export name.
 */
function readExport (source, name) {
  if (name === 'module.exports' && !Object.hasOwn(source, name)) {
    return source.default
  }
  return source[name]
}

/**
 * @param {object} target The proxy target.
 * @param {string | symbol} name The export name.
 * @param {unknown} value The replacement value.
 */
function setExport (target, name, value) {
  return binders.get(target).write(name, value)
}

/**
 * @param {object} target The proxy target.
 * @param {string | symbol} name The export name.
 * @returns {unknown} The current export value.
 */
function getExport (target, name) {
  return binders.get(target).read(name)
}

/**
 * @param {object} target The proxy target.
 * @param {string | symbol} name The export name.
 * @returns {PropertyDescriptor | undefined} The current export descriptor.
 */
function getExportDescriptor (target, name) {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, name)
  if (descriptor !== undefined && 'value' in descriptor) {
    descriptor.value = binders.get(target).read(name)
  }
  return descriptor
}

/**
 * @param {object} target The proxy target.
 * @param {string | symbol} name The export name.
 * @param {PropertyDescriptor} descriptor The replacement descriptor.
 */
function defineExport (target, name, descriptor) {
  if (!('value' in descriptor)) {
    throw new Error('Getters/setters are not supported for exports property descriptors.')
  }
  return setExport(target, name, descriptor.value)
}

const proxyHandler = { defineProperty: defineExport, set: setExport }
const liveProxyHandler = {
  defineProperty: defineExport,
  get: getExport,
  getOwnPropertyDescriptor: getExportDescriptor,
  set: setExport
}

/**
 * @param {object} target The proxy target.
 * @param {string | symbol} name The export name.
 * @param {unknown} value The replacement value.
 */
function setLegacyExport (target, name, value) {
  const setter = legacySetters.get(target)?.[name]
  return typeof setter === 'function' ? setter(value) : true
}

/**
 * @param {object} target The proxy target.
 * @param {string | symbol} name The export name.
 */
function getLegacyExport (target, name) {
  if (name === Symbol.toStringTag) return 'Module'

  const getter = legacyGetters.get(target)[name]
  if (typeof getter === 'function') return getter()
}

/**
 * @param {object} target The proxy target.
 * @param {string | symbol} name The export name.
 * @param {PropertyDescriptor} descriptor The replacement descriptor.
 */
function defineLegacyExport (target, name, descriptor) {
  if (!('value' in descriptor)) {
    throw new Error('Getters/setters are not supported for exports property descriptors.')
  }
  return setLegacyExport(target, name, descriptor.value)
}

/**
 * @param {string} name The wrapped module URL.
 * @param {object} namespace The wrapper's module namespace.
 * @param {object} set The wrapper's export setters.
 * @param {object} get The wrapper's export getters.
 * @param {string} specifier The original import specifier.
 */
function registerLegacy (name, namespace, set, get, specifier) {
  legacySetters ??= new WeakMap()
  legacyGetters ??= new WeakMap()
  legacyProxyHandler ??= {
    defineProperty: defineLegacyExport,
    get: getLegacyExport,
    set: setLegacyExport
  }
  specifiers.set(name, specifier)
  legacySetters.set(namespace, set)
  legacyGetters.set(namespace, get)
  const proxy = new Proxy(namespace, legacyProxyHandler)
  importHooks.forEach(hook => hook(name, proxy, specifier))
  toHook.push([name, proxy, specifier])
}

/**
 * @param {string} name The wrapped module URL.
 * @param {ModuleBinder | object} binder The wrapper's binding state or legacy namespace.
 * @param {string | object} specifier The original import specifier or legacy setters.
 * @param {object | boolean} [getOrBridgeRequire] The legacy getters or whether Hooks may require the pending module.
 * @param {string | boolean} [specifierOrLive] The legacy specifier or whether reads follow native live bindings.
 */
function register (name, binder, specifier, getOrBridgeRequire, specifierOrLive) {
  if (typeof specifier === 'object') {
    registerLegacy(name, binder, specifier, getOrBridgeRequire, specifierOrLive)
    return
  }

  const bridgeRequire = getOrBridgeRequire === true
  const live = specifierOrLive === true
  const { namespace } = binder
  specifiers.set(name, specifier)
  binders.set(namespace, binder)
  const proxy = new Proxy(namespace, live ? liveProxyHandler : proxyHandler)
  if (!bridgeRequire) {
    importHooks.forEach(hook => hook(name, proxy, specifier))
    toHook.push([name, proxy, specifier])
    return
  }

  const cacheBridge = iitmGlobal[cacheBridgeKey]
  const cachedModule = cacheBridge?.begin(name, proxy)
  // The generated registration call is the module's final statement, but Node
  // does not mark the ESM job evaluated until it returns. Bridge only the Hook
  // callback so a re-entrant require() observes the same exports instead of
  // failing with ERR_REQUIRE_CYCLE_MODULE.
  try {
    importHooks.forEach(hook => hook(name, proxy, specifier))
    toHook.push([name, proxy, specifier])
  } finally {
    cacheBridge?.end(cachedModule)
  }
}

// Delays (ms) for re-reading exports that were still in their temporal dead zone
// when the wrapper first ran (circular imports). Retried on a microtask first,
// then at these intervals; unref'd so best-effort retries never hold the process
// open. Frozen once at module load rather than rebuilt per wrapper.
const RETRY_DELAYS = [0, 10, 50]

/**
 * Per-wrapped-module state a generated wrapper builds once to expose its exports
 * through iitm's proxy. Each wrapper supplies one indexed writer for all local
 * bindings; the constructor seeds them from the real module, and `flush`
 * resolves any export that was undefined (circular import) once it becomes available.
 *
 * This is the boilerplate the wrapper used to inline in full per module. Hoisting
 * it here compiles the retry and proxy bookkeeping once instead of once per
 * wrapped module.
 */
class ModuleBinder {
  // Mimics a Module namespace object (https://tc39.es/ecma262/#sec-module-namespace-objects).
  namespace = Object.create(null, { [Symbol.toStringTag]: { value: 'Module' } })
  #read
  #set = Object.create(null)
  #write
  #overridden
  #pending

  /**
   * @param {string} name The instrumented module URL.
   * @param {string} specifier The original import specifier.
   * @param {string[]} keys Export names in binding order.
   * @param {unknown[]} values Initial export values.
   * @param {((index: number) => unknown) | undefined} read Reads a native live binding by index.
   * @param {(index: number, value: unknown) => void} write Assigns an exported binding by index.
   * @param {boolean} bridgeRequire Whether Hooks may require the pending module.
   */
  static bindInPlace (name, specifier, keys, values, read, write, bridgeRequire) {
    const binder = new ModuleBinder()
    binder.#read = read
    binder.#write = write
    for (let index = 0; index < keys.length; index++) {
      binder.namespace[keys[index]] = values[index]
      binder.#set[keys[index]] = index
    }
    register(name, binder, specifier, bridgeRequire, true)
  }

  /**
   * @param {string | symbol} key The export name.
   * @returns {unknown} The current exported value.
   */
  read (key) {
    const index = this.#set[key]
    return index === undefined || this.#read === undefined
      ? this.namespace[key]
      : this.#read(index)
  }

  /**
   * @param {object} [source] The wrapped module namespace.
   * @param {string[]} [keys] Export names in wrapper-binding order.
   * @param {(index: number, value: unknown) => void} [write] Assigns a wrapper binding by index.
   * @param {object[]} [sources] Alternate namespaces for star-collision bindings.
   */
  constructor (source, keys, write, sources) {
    this.#write = write
    if (keys !== undefined) {
      for (let index = 0; index < keys.length; index++) {
        this.#bind(keys[index], index, sources?.[index] ?? source)
      }
    }
  }

  /**
   * @param {string} key The export name.
   * @param {number} index The binding index.
   * @param {unknown} value The initial value.
   */
  #seed (key, index, value) {
    this.#write(index, value)
    this.namespace[key] = value
  }

  /**
   * Seeds `key` from `source` and installs its proxy accessors. A value that is
   * undefined or throws `ReferenceError` (temporal dead zone during a circular
   * import) is deferred to `flush`; any other throw propagates.
   *
   * @param {string} key The export name.
   * @param {number} index The wrapper binding index.
   * @param {object} source The binding's source namespace.
   * @returns {void}
   */
  #bind (key, index, source) {
    let value
    try {
      value = readExport(source, key)
      this.#seed(key, index, value)
    } catch (error) {
      if (!(error instanceof ReferenceError)) throw error
    }
    if (value === undefined) {
      (this.#pending ??= []).push(this.#makeUpdater(key, index, source))
    }
    this.#set[key] = index
  }

  /**
   * @param {string | symbol} key The export name.
   * @param {unknown} value The replacement value.
   * @returns {boolean}
   */
  write (key, value) {
    const index = this.#set[key]
    if (index !== undefined) {
      this.#write(index, value)
      if (this.#pending !== undefined) {
        this.#overridden ??= Object.create(null)
        this.#overridden[key] = true
      }
      this.namespace[key] = value
    }
    return true
  }

  /**
   * @param {string} key The export name to update.
   * @param {number} index The wrapper binding index.
   * @param {object} source The real module namespace.
   * @returns {() => boolean} Updater returning whether the value is now settled.
   */
  #makeUpdater (key, index, source) {
    return () => {
      if (this.#overridden?.[key] === true) return true
      try {
        const value = readExport(source, key)
        if (value !== undefined) {
          this.#write(index, value)
          this.namespace[key] = value
          return true
        }
        return false
      } catch (error) {
        if (error instanceof ReferenceError) return false
        // Only reached if a getter starts throwing a non-ReferenceError after the
        // initial bind read already succeeded or deferred; surfaces in flush's
        // microtask. Kept as-is from the inline wrapper.
        /* c8 ignore next */
        throw error
      }
    }
  }

  #flushOnce () {
    const pending = this.#pending
    if (pending === undefined) return

    let next
    for (const updater of pending) {
      // If it still throws ReferenceError, keep it for the (single) next attempt.
      if (updater() !== true) (next ??= []).push(updater)
    }
    this.#pending = next
  }

  /**
   * Resolves exports deferred by `bind` (undefined or TDZ at wrapper-eval time).
   * Retries on a microtask, then at `RETRY_DELAYS`, giving up afterwards to avoid
   * unbounded retries. A no-op when nothing was deferred.
   *
   * @returns {void}
   */
  flush () {
    if (this.#pending === undefined) return
    queueMicrotask(() => {
      this.#flushOnce()
      this.#scheduleRetry(0)
    })
  }

  /**
   * @param {number} attempt Index into `RETRY_DELAYS` for the next retry.
   * @returns {void}
   */
  #scheduleRetry (attempt) {
    if (this.#pending === undefined) return
    if (attempt >= RETRY_DELAYS.length) {
      // Give up: leave exports as-is to avoid unbounded retries.
      this.#pending = undefined
      return
    }
    const timer = setTimeout(() => {
      this.#flushOnce()
      this.#scheduleRetry(attempt + 1)
    }, RETRY_DELAYS[attempt])
    // Don't keep the process alive just for best-effort retries.
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
}

exports.register = register
exports.ModuleBinder = ModuleBinder
exports.importHooks = importHooks
exports.specifiers = specifiers
exports.toHook = toHook

iitmGlobal[__filename] = ModuleBinder.bindInPlace
