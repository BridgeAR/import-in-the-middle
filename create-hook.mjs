// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { URL, fileURLToPath } from 'url'
import { inspect } from 'util'
import { Module, builtinModules, createRequire } from 'module'
import { getModuleExports, sourceToString } from './lib/get-exports.mjs'
import { parseEsm } from './lib/get-esm-exports.mjs'
import { RESOLVE, driveSync, driveAsync } from './lib/io.mjs'
import { supportsSyncHooks } from './supports-sync-hooks.mjs'

// Re-exported for backwards compatibility: `supportsSyncHooks` now lives in its
// own import-free module so a CommonJS preloader can check it without loading
// this file's acorn / cjs-module-lexer dependency graph.
export { supportsSyncHooks }

const isWin = process.platform === 'win32'

// Depth at which `processModule` starts tracking visited URLs to break an
// `export *` cycle. Real re-export chains are only a few levels deep, so this
// is far beyond any legitimate graph yet well below the call-stack limit a
// cycle would otherwise hit. Below it the recursion pays only an integer
// compare per level and allocates no set.
const STAR_CYCLE_DEPTH = 100
const IN_PLACE_UNSAFE_IDENTIFIER_RE = /\\u|__[iI]itm|\b(?:globalThis|Symbol)\b/

// FIXME: Typescript extensions are added temporarily until we find a better
// way of supporting arbitrary extensions
const EXTENSION_RE = /\.(js|mjs|cjs|ts|mts|cts)$/
// The full es-module-lexer build handles erasable TypeScript syntax in the same
// pass as JavaScript, so the `-typescript` formats use the normal export path.
const HANDLED_FORMATS = new Set([
  'builtin', 'module', 'commonjs', 'module-typescript', 'commonjs-typescript'
])
const TRACE_WARNINGS = process.execArgv.includes('--trace-warnings')

/** @typedef {import('node:module').LoadHookContext} LoadContext */
/** @typedef {import('node:module').LoadFnOutput} LoadResult */
/** @typedef {(url: string, context?: Partial<LoadContext>) => LoadResult} LoadFunction */
/** @typedef {ReturnType<typeof parseEsm>} EsmParseResult */
/** @typedef {string | { specifier: string, format: 'module-typescript' | 'commonjs-typescript' }} SpecifierData */
/** @typedef {{ name: string, origin: string }} StarBinding */
/**
 * @typedef {object} ProcessResult
 * @property {string[] | Map<string, string | StarBinding>} bindings
 * @property {Map<string, string> | undefined} origins
 */

function hasIitm (url) {
  // Fast path: avoid URL parsing on the hot path when there's clearly no iitm.
  if (typeof url !== 'string' || url.indexOf('iitm') === -1) {
    return false
  }
  try {
    return new URL(url).searchParams.has('iitm')
  } catch {
    return false
  }
}

function isIitm (url, meta) {
  return url === meta.url || url === meta.url.replace('hook.mjs', 'create-hook.mjs')
}

function deleteIitm (url) {
  // Fast path: avoid URL parsing / try-catch on bare specifiers and normal file URLs.
  if (typeof url !== 'string' || url.indexOf('iitm') === -1) {
    return url
  }
  let resultUrl
  const stackTraceLimit = Error.stackTraceLimit
  try {
    Error.stackTraceLimit = 0
    const urlObj = new URL(url)
    if (urlObj.searchParams.has('iitm')) {
      urlObj.searchParams.delete('iitm')
      resultUrl = urlObj.href
      if (resultUrl.startsWith('file:///node:')) {
        resultUrl = resultUrl.replace('file:///', '')
      }
    } else {
      resultUrl = urlObj.href
    }
  } catch {
    resultUrl = url
  }
  Error.stackTraceLimit = stackTraceLimit
  return resultUrl
}

function isBareSpecifier (specifier) {
  // Relative and absolute paths are not bare specifiers.
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/')) {
    return false
  }

  // Valid URLs are not bare specifiers. (file:, http:, node:, etc.)

  // eslint-disable-next-line no-prototype-builtins
  if (URL.hasOwnProperty('canParse')) {
    return !URL.canParse(specifier)
  }

  const stackTraceLimit = Error.stackTraceLimit
  try {
    Error.stackTraceLimit = 0
    // eslint-disable-next-line no-new
    new URL(specifier)
    return false
  } catch (err) {
    return true
  } finally {
    Error.stackTraceLimit = stackTraceLimit
  }
}

/**
 * Determines whether the input is a bare specifier, file URL or a regular expression.
 *
 * - node: prefixed URL strings are considered bare specifiers in this context.
 */
function isBareSpecifierFileUrlOrRegex (input) {
  if (input instanceof RegExp) {
    return true
  }

  // Relative and absolute paths
  if (
    input.startsWith('.') ||
    input.startsWith('/')) {
    return false
  }

  const stackTraceLimit = Error.stackTraceLimit
  try {
    Error.stackTraceLimit = 0
    // eslint-disable-next-line no-new
    const url = new URL(input)
    // We consider node: URLs bare specifiers in this context
    return url.protocol === 'file:' || url.protocol === 'node:'
  } catch (err) {
    // Anything that fails parsing is a bare specifier
    return true
  } finally {
    Error.stackTraceLimit = stackTraceLimit
  }
}

/**
 * Ensure an array only contains bare specifiers, file URLs or regular expressions.
 *
 * - We consider node: prefixed URL string as bare specifiers in this context.
 * - For node built-in modules, we add additional node: prefixed modules to the
 *   output array.
 */
function ensureArrayWithBareSpecifiersFileUrlsAndRegex (array, type) {
  if (!Array.isArray(array)) {
    return undefined
  }

  const invalid = array.filter(s => !isBareSpecifierFileUrlOrRegex(s))

  if (invalid.length) {
    throw new Error(`'${type}' option only supports bare specifiers, file URLs or regular expressions. Invalid entries: ${inspect(invalid)}`)
  }

  // Rather than evaluate whether we have a node: scoped built-in-module for
  // every call to resolve, we just add them to include/exclude now.
  for (const each of array) {
    if (typeof each === 'string' && !each.startsWith('node:') && builtinModules.includes(each)) {
      array.push(`node:${each}`)
    }
  }

  return array
}

function emitWarning (err) {
  // Unfortunately, process.emitWarning does not output the full error
  // with error.cause like console.warn does so we need to inspect it when
  // tracing warnings
  const warnMessage = TRACE_WARNINGS ? inspect(err) : err
  process.emitWarning(warnMessage)
}

/**
 * @param {string} name The exported name.
 * @param {string} sourceUrl The URL of the module that defines the export.
 */
function shouldReexport (name, sourceUrl) {
  return name !== 'module.exports' ||
    (!sourceUrl.startsWith('node:') && !builtinModules.includes(sourceUrl))
}

/**
 * @param {string} name The exported name.
 * @param {string} sourceUrl The URL of the module that defines the export.
 */
function shouldExcludeExport (name, sourceUrl) {
  return name === 'default' || !shouldReexport(name, sourceUrl)
}

/**
 * Processes a module's exports and builds its wrapper bindings.
 *
 * Written as a "sans-io" generator (see `lib/io.mjs`): instead of calling the
 * loader's resolve/load hooks directly it `yield`s `[RESOLVE, ...]` to resolve
 * star re-exports and `[LOAD, ...]` (via {@link getModuleExports}) to read source,
 * and is driven by either {@link driveSync} (for
 * `module.registerHooks`) or {@link driveAsync} (for `module.register`). The
 * body is identical for both, so there is a single implementation to maintain.
 *
 * @param {object} params
 * @param {string} params.srcUrl The full URL to the module to process.
 * @param {LoadContext} params.context Provided by the loaders API.
 * @param {boolean} [params.excludeDefault = false] Exclude the default export.
 * @param {number} [params.depth = 0] Star-re-export recursion depth. Used to
 * detect `export *` cycles (`a` re-exports `b`, `b` re-exports `a`) cheaply:
 * the acyclic common case pays only an integer compare per level, and the
 * cycle-tracking set is allocated only once recursion is implausibly deep.
 * @param {Set<string>} [params.seen] URLs currently on the recursion stack,
 * created lazily once `depth` crosses {@link STAR_CYCLE_DEPTH}. A URL is added
 * before descending into its subtree and removed once that subtree finishes, so
 * it tracks the active path rather than every URL ever visited.
 * @param {EsmParseResult} [params.parsed] A lexer result already produced for the root source.
 * @returns {Generator<Array, ProcessResult>}
 * A generator that yields I/O operations and ultimately returns the shimmed
 * bindings for all the exports from the module and any transitive export all
 * modules. `origins` (the defining module per `*`-sourced name) is `undefined`
 * for a module with no `export *`.
 */
function * processModule ({ srcUrl, context, excludeDefault = false, depth = 0, seen, parsed }) {
  const { exportNames, starReexports } = yield * getModuleExports(srcUrl, context, parsed)

  // Most modules have no export star. Keep that path array-backed so it pays
  // neither merge bookkeeping nor a Map lookup for each direct export.
  if (starReexports === undefined) {
    if (!excludeDefault) {
      return { bindings: exportNames, origins: undefined }
    }

    const bindings = []
    for (const name of exportNames) {
      if (shouldExcludeExport(name, srcUrl)) continue
      bindings.push(name)
    }
    return { bindings, origins: undefined }
  }

  const bindings = new Map()

  // Maps each live `*`-sourced name to the module that defined it. Its keys
  // double as "this name came from a `*` re-export" (so an explicit export can
  // override it), and its values let two `*` re-exports of the same name be told
  // apart. Allocated on the first `export *`, never for a module without one; a
  // single Map carries both facts so a star with no collision pays one structure
  // and one write per name, not two.
  let starOrigins
  let ambiguousStars
  let firstStarUrl
  let processedStarUrls

  for (const name of exportNames) {
    if (excludeDefault && shouldExcludeExport(name, srcUrl)) continue
    bindings.set(name, name)
  }

  for (const { specifier, parentURL } of starReexports) {
    // Relative paths need to be resolved relative to the module declaring the star.
    const newSpecifier = isBareSpecifier(specifier) ? specifier : new URL(specifier, parentURL).href
    // We need to resolve bare specifiers to a full URL. We also need to
    // resolve all sub-modules to get the `format`. We can't rely on the
    // parent's `format` to know if this sub-module is ESM or CJS!
    const result = yield [RESOLVE, newSpecifier, { parentURL }]

    // Most star modules have one target. Defer the collection until a second
    // distinct target while still ignoring repeated declarations.
    if (firstStarUrl === undefined) {
      firstStarUrl = result.url
    } else if (processedStarUrls === undefined) {
      if (result.url === firstStarUrl) continue
      processedStarUrls = [firstStarUrl, result.url]
    } else {
      if (processedStarUrls.includes(result.url)) continue
      processedStarUrls.push(result.url)
    }

    // First `*` re-export: allocate the origin bookkeeping lazily.
    starOrigins ??= new Map()

    // `export *` graphs are normally only a handful of levels deep. A cycle
    // (`a` re-exports `b`, `b` re-exports `a`) instead recurses without bound
    // and exhausts memory. Rather than track every URL on the common shallow
    // path, only start recording once the depth is implausibly large for a
    // real graph; from there a re-export pointing back at a module already on
    // the recursion stack is the cycle, and is skipped (its exports are
    // collected by the in-progress ancestor frame). `seen` mirrors the stack,
    // not every URL visited: a module reached and fully processed through one
    // sibling branch must stay reachable through a later, more direct branch,
    // so it is removed again once its subtree finishes.
    if (depth >= STAR_CYCLE_DEPTH) {
      seen ??= new Set()
      if (seen.has(result.url)) continue
      seen.add(result.url)
    }

    try {
      const sub = yield * processModule({
        srcUrl: result.url,
        context: { ...context, format: result.format },
        excludeDefault: true,
        depth: depth + 1,
        seen
      })

      for (const binding of sub.bindings.values()) {
        const directName = typeof binding === 'string' ? binding : undefined
        const name = directName ?? binding.name
        if (ambiguousStars?.has(name)) continue

        const origin = directName === undefined ? binding.origin : sub.origins?.get(name) ?? result.url
        if (bindings.has(name)) {
          // An explicit export shadows every star re-export.
          if (!starOrigins.has(name)) continue

          if (starOrigins.get(name) === origin) {
            // IITM's aggregate namespace sees the wrapped paths as ambiguous.
            // Retain the defining URL so source generation can import it once.
            bindings.set(name, { name, origin })
          } else {
            bindings.delete(name)
            starOrigins.delete(name)
            ambiguousStars ??= new Set()
            ambiguousStars.add(name)
          }
        } else {
          starOrigins.set(name, origin)
          bindings.set(name, binding)
        }
      }
    } finally {
      seen?.delete(result.url)
    }
  }

  return { bindings, origins: starOrigins }
}

function addIitm (url) {
  const urlObj = new URL(url)
  urlObj.searchParams.set('iitm', 'true')
  return urlObj.href
}

function addIitmOriginal (url) {
  const urlObj = new URL(url)
  urlObj.searchParams.set('iitm', 'original')
  return urlObj.href
}

function isIitmOriginal (url) {
  if (typeof url !== 'string' || url.indexOf('iitm') === -1) return false
  try {
    return new URL(url).searchParams.get('iitm') === 'original'
  } catch {
    return false
  }
}

/**
 * @param {{ url: string }} meta
 * @param {typeof import('./lib/rewrite-esm-exports.mjs').rewriteEsmExports} [rewriteExports]
 * @param {typeof import('./lib/rewrite-esm-exports.mjs').canUseRequireCacheBridge} [canBridgeRequire]
 */
export function createHook (meta, rewriteExports, canBridgeRequire) {
  /** @type {Map<string, SpecifierData>} */
  const specifiers = new Map()
  let cachedResolve
  const iitmURL = new URL('lib/register.js', meta.url).toString()
  const iitmRegisterPath = fileURLToPath(iitmURL)
  const canonicalDoneKey = `${iitmRegisterPath}:canonical-done:${meta.url}`
  const cachedNamespaceKey = `${iitmRegisterPath}:cached-namespace:${meta.url}`
  const cacheBridgeKey = `${iitmRegisterPath}:cache-bridge`
  const requireCache = rewriteExports === undefined ? undefined : createRequire(meta.url).cache
  const inPlaceBinder = rewriteExports === undefined
    ? undefined
    : `globalThis[Symbol.for('import-in-the-middle')][${JSON.stringify(iitmRegisterPath)}]`
  let includeModules, excludeModules
  let shouldInclude = defaultShouldInclude
  let disableCjsSourceStripping = false
  // Filtered aliases can resolve to the same URL without sharing the query-tagged
  // identity used by the in-place path, which would evaluate the module twice.
  let canRewriteInPlace = true

  // Track CJS module URLs that IITM has wrapped. On Node 24+, CJS modules loaded
  // via loadCJSModule (in an ESM import chain) have their require() calls for
  // builtins routed through the ESM resolver. Without this guard, IITM would
  // intercept those require() calls and return an ESM namespace object instead
  // of the native CJS module value (e.g. EventEmitter constructor), breaking
  // patterns like `class App extends require('events') {}`.
  const cjsInIitmChain = new Set()
  const canonicalWrappers = new Set()
  const canonicalModules = new Set()
  const originalImportMeta = new Set()
  const requiredModules = new Set()

  if (rewriteExports !== undefined) {
    const iitmGlobal = globalThis[Symbol.for('import-in-the-middle')]
    iitmGlobal[canonicalDoneKey] = (url) => canonicalWrappers.delete(url)
    iitmGlobal[cachedNamespaceKey] = (url) => getRequireCached(url)?.exports
    iitmGlobal[cacheBridgeKey] = {
      /**
       * @param {string} name The in-place module URL.
       * @param {object} proxy The Hook-facing exports proxy.
       * @returns {Module | undefined} The temporary cache entry, if one was installed.
       */
      begin (name, proxy) {
        if (!name.startsWith('file:')) return

        const filename = fileURLToPath(name)
        if (requireCache[filename] !== undefined) return

        const cachedModule = new Module(filename)
        cachedModule.filename = filename
        cachedModule.loaded = true
        cachedModule.exports = proxy
        requireCache[filename] = cachedModule
        return cachedModule
      },
      /**
       * @param {Module | undefined} cachedModule The temporary cache entry.
       * @returns {void}
       */
      end (cachedModule) {
        if (cachedModule !== undefined && requireCache[cachedModule.filename] === cachedModule) {
          delete requireCache[cachedModule.filename]
        }
      }
    }
  }

  // Default matcher, used unless the consumer supplies its own `shouldInclude`
  // (see applyOptions). It applies the include/exclude lists, so finishResolve
  // always has a predicate to call and never has to special-case its absence.
  //
  // We check the specifier to match libraries loaded with bare specifiers from
  // node_modules, and the full file URL for non-bare specifier imports (relative
  // paths would be error prone). An absolute path entry added via Hook over the
  // message port matches the resolved file path, so it is resolved here.
  function defaultShouldInclude (url, specifier) {
    let resultPath
    if (url.startsWith('file:')) {
      const stackTraceLimit = Error.stackTraceLimit
      Error.stackTraceLimit = 0
      try {
        resultPath = fileURLToPath(url)
      } catch {}
      Error.stackTraceLimit = stackTraceLimit
    }
    function match (each) {
      if (each instanceof RegExp) {
        return each.test(url)
      }

      return each === specifier || each === url || (resultPath && each === resultPath)
    }

    if (includeModules && !includeModules.some(match)) {
      return false
    }

    if (excludeModules && excludeModules.some(match)) {
      return false
    }

    return true
  }

  // Applies the include/exclude/message-port configuration. Shared by the
  // asynchronous `initialize` (off-thread `module.register`, which receives
  // `data` over the registration boundary) and by synchronous registration
  // (`module.registerHooks`), which has no `initialize` step and passes the
  // same options directly.
  function applyOptions (data) {
    includeModules = ensureArrayWithBareSpecifiersFileUrlsAndRegex(data.include, 'include')
    excludeModules = ensureArrayWithBareSpecifiersFileUrlsAndRegex(data.exclude, 'exclude')

    // A consumer can supply its own matcher as `shouldInclude(url, specifier)`,
    // taking ownership of the include/exclude decision instead of expressing it
    // as bare-specifier / file-URL / regex lists. It replaces the default list
    // matcher and is called with the resolved URL and specifier; otherwise the
    // default applies the include/exclude options.
    shouldInclude = typeof data.shouldInclude === 'function' ? data.shouldInclude : defaultShouldInclude
    canRewriteInPlace = includeModules === undefined && excludeModules === undefined &&
      shouldInclude === defaultShouldInclude && !data.addHookMessagePort

    if (data.disableCjsSourceStripping === true) {
      disableCjsSourceStripping = true
    }

    if (data.addHookMessagePort) {
      data.addHookMessagePort.on('message', (modules) => {
        if (includeModules === undefined) {
          includeModules = []
        }

        for (const each of modules) {
          if (!each.startsWith('node:') && builtinModules.includes(each)) {
            includeModules.push(`node:${each}`)
          }

          includeModules.push(each)
        }

        data.addHookMessagePort.postMessage('ack')
      }).unref()
    }
  }

  async function initialize (data) {
    if (global.__import_in_the_middle_initialized__) {
      process.emitWarning("The 'import-in-the-middle' hook has already been initialized")
    }

    global.__import_in_the_middle_initialized__ = true

    if (data) {
      applyOptions(data)
    }
  }

  // Shared post-processing for the `resolve` hook: everything that happens
  // once the parent loader has turned the specifier into a resolved URL. The
  // only difference between the asynchronous and synchronous hooks is whether
  // that resolution was awaited, so all the wrapping decisions live here.
  function finishResolve (result, specifier, context, parentURL, preferInPlace = false) {
    // Do not wrap the entrypoint module. Many CLIs check whether they are the
    // "main" module (e.g. require.main === module). Wrapping changes how they
    // are evaluated, and can make them exit without doing anything.
    if (parentURL === '') {
      if (!EXTENSION_RE.test(result.url) && !hasIitm(result.url)) {
        return { url: result.url, format: 'commonjs' }
      }
      return result
    }

    // Never wrap a module whose format we don't handle (e.g. json, wasm); this
    // holds regardless of how inclusion is decided below.
    if (result.format && !HANDLED_FORMATS.has(result.format)) {
      return result
    }

    // The synchronous hooks (`module.registerHooks`) fire for `require()` as well
    // as `import`, but iitm only owns the ESM graph: CommonJS modules are
    // instrumented separately through require-in-the-middle, and `require()` must
    // return the native, mutable module value (e.g. graceful-fs does
    // `Object.defineProperty(require('fs'), ...)`, which throws on a frozen ESM
    // namespace). Node reports the active module system in `context.conditions`
    // ('require' vs 'import'), so leave any require() resolution untouched. The
    // asynchronous hook never sees the 'require' condition, so this is a no-op
    // there and only affects the synchronous path.
    if (context.conditions?.includes('require')) {
      if (preferInPlace && !canonicalModules.has(result.url)) requiredModules.add(result.url)
      return result
    }

    // `shouldInclude` is always set (the include/exclude list matcher by default,
    // a consumer-provided predicate otherwise), so no nullish check is needed.
    if (!shouldInclude(result.url, specifier)) {
      return result
    }

    if (isIitm(parentURL, meta)) return result
    if (canonicalWrappers.has(parentURL)) return result
    if (parentURL && hasIitm(parentURL) && !isIitmOriginal(parentURL)) return result

    // When a CJS module is loaded by an IITM shim, its require() calls for
    // builtins may be routed through the ESM resolver on Node 24+. Skip IITM
    // wrapping in that case so require() returns the native module value.
    // We also propagate the membership to the resolved child so that its own
    // transitive require() calls are likewise skipped (the entire synchronous
    // CJS require chain must remain unwrapped to avoid ERR_VM_MODULE_LINK_FAILURE).
    if (cjsInIitmChain.has(parentURL)) {
      cjsInIitmChain.add(result.url)
      return result
    }

    // We don't want to attempt to wrap native modules
    if (result.url.endsWith('.node')) {
      return result
    }

    // Node.js v21 renames importAssertions to importAttributes
    const importAttributes = context.importAttributes || context.importAssertions
    if (importAttributes && importAttributes.type === 'json') {
      return result
    }

    // If the file is referencing itself, keep the identity of the currently
    // evaluating module. A canonical wrapper evaluates the original source at
    // an internal URL, so its self-import must retain that URL as well.
    const selfUrl = isIitmOriginal(parentURL) ? deleteIitm(parentURL) : parentURL
    if (result.url === selfUrl) {
      return {
        url: isIitmOriginal(parentURL) ? parentURL : result.url,
        shortCircuit: true,
        format: result.format
      }
    }

    // A canonical wrapper evaluates the original source under an internal URL.
    // Route a cycle back to that active original module instead of the wrapper,
    // whose exports are still in their temporal dead zone during linking.
    if (isIitmOriginal(parentURL) && canonicalWrappers.has(result.url)) {
      return {
        url: addIitmOriginal(result.url),
        shortCircuit: true,
        format: result.format
      }
    }

    // Preserve the format before an outer loader can normalize it.
    const specifierData = result.format === 'module-typescript' || result.format === 'commonjs-typescript'
      ? { specifier, format: result.format }
      : specifier
    specifiers.set(result.url, specifierData)

    if (preferInPlace && result.format === 'module' && (
      canonicalModules.has(result.url) ||
      (!requiredModules.has(result.url) && !isRequireCached(result.url)))) {
      return {
        url: result.url,
        shortCircuit: true,
        format: result.format
      }
    }

    return {
      url: addIitm(result.url),
      shortCircuit: true,
      // Node's synchronous resolver drops `format: 'builtin'` for bare builtin
      // specifiers (`require('crypto')` -> `node:crypto`), so restore it;
      // otherwise the load hook reads `node:crypto` from disk and throws ENOENT.
      format: result.format ?? (result.url.startsWith('node:') ? 'builtin' : undefined)
    }
  }

  async function resolve (specifier, context, parentResolve) {
    cachedResolve = parentResolve

    // See https://github.com/nodejs/import-in-the-middle/pull/76.
    if (specifier === iitmURL) {
      return {
        url: specifier,
        shortCircuit: true
      }
    }

    const { parentURL = '' } = context
    const newSpecifier = deleteIitm(specifier)
    if (isWin && parentURL.indexOf('file:node') === 0) {
      context.parentURL = ''
    }
    const result = await parentResolve(newSpecifier, context)

    return finishResolve(result, specifier, context, parentURL)
  }

  // Synchronous counterpart to `resolve`, for `module.registerHooks`. The
  // synchronous `nextResolve` returns its result directly. We stash it so the
  // synchronous `load` hook can resolve star re-exports later, mirroring how
  // `resolve` caches `parentResolve`.
  function resolveSync (specifier, context, nextResolve) {
    cachedResolve = nextResolve

    if (specifier === iitmURL) {
      return {
        url: specifier,
        shortCircuit: true
      }
    }

    if (isIitmOriginal(specifier)) {
      return {
        url: specifier,
        shortCircuit: true,
        format: 'module'
      }
    }

    const { parentURL = '' } = context
    const newSpecifier = deleteIitm(specifier)
    if (isWin && parentURL.indexOf('file:node') === 0) {
      context.parentURL = ''
    }
    const result = nextResolve(newSpecifier, context)

    return finishResolve(result, specifier, context, parentURL, rewriteExports !== undefined && canRewriteInPlace)
  }

  /**
   * Builds the wrapper module source shared by the asynchronous and synchronous hooks.
   *
   * @param {string} realUrl The URL of the wrapped module.
   * @param {string[] | Map<string, string | StarBinding>} bindings Its exported bindings.
   * @param {string} originalSpecifier The specifier used to import the module.
   * @param {string} [namespaceUrl] The URL from which the original namespace is loaded.
   * @param {boolean} [fromCache] Whether to read a preloaded namespace from require.cache.
   * @param {boolean} [bridgeRequire] Whether Hooks may require the pending canonical wrapper.
   */
  function buildWrapperSource (
    realUrl,
    bindings,
    originalSpecifier,
    namespaceUrl = realUrl,
    fromCache = false,
    bridgeRequire = false
  ) {
    // The wrapped module imports its namespace as `namespace`, which serves
    // every export but the ones a same-origin `export *` collision forced onto
    // their defining module (#171): the aggregate namespace drops those as
    // ambiguous under iitm, so each such defining module gets its own alias the
    // wrapper imports. Without such a collision nothing is added.
    let originImports = ''
    let originNamespaces
    let declarationNames = ''
    let bindingNames = ''
    let bindingSources
    let exportSpecifiers = ''
    let writeCases = ''
    let index = 0
    for (const binding of bindings.values()) {
      const directName = typeof binding === 'string' ? binding : undefined
      const name = directName ?? binding.name
      let namespaceName = 'namespace'
      if (directName === undefined) {
        originNamespaces ??= new Map()
        namespaceName = originNamespaces.get(binding.origin)
        if (namespaceName === undefined) {
          namespaceName = `__ns${originNamespaces.size}`
          originNamespaces.set(binding.origin, namespaceName)
          originImports += `import * as ${namespaceName} from ${JSON.stringify(binding.origin)}\n`
        }
      }
      const variableName = `$${index}`
      const objectKey = JSON.stringify(name)
      declarationNames += declarationNames === '' ? variableName : `, ${variableName}`
      bindingNames += bindingNames === '' ? objectKey : `, ${objectKey}`
      if (bindingSources !== undefined) bindingSources += ', '
      if (namespaceName !== 'namespace') {
        bindingSources ??= 'undefined, '.repeat(index)
        bindingSources += namespaceName
      } else if (bindingSources !== undefined) {
        bindingSources += 'undefined'
      }
      writeCases += `    case ${index++}: ${variableName} = value; break\n`
      if (shouldReexport(name, realUrl)) {
        const exportName = name === 'default' ? name : objectKey
        exportSpecifiers += exportSpecifiers === ''
          ? `${variableName} as ${exportName}`
          : `, ${variableName} as ${exportName}`
      }
    }
    const binder = declarationNames === ''
      ? 'const __binder = new ModuleBinder(namespace)\n'
      : `let ${declarationNames}
function __write (index, value) {
  switch (index) {
${writeCases}  }
}
const __binder = new ModuleBinder(namespace, [${bindingNames}], __write${bindingSources === undefined
  ? ''
  : `, [${bindingSources}]`})
`
    const reexports = exportSpecifiers === '' ? '' : `export { ${exportSpecifiers} }\n`

    const completeCanonicalWrapper = namespaceUrl === realUrl
      ? ''
      : `globalThis[Symbol.for('import-in-the-middle')][${JSON.stringify(canonicalDoneKey)}](${JSON.stringify(realUrl)})\n`

    const namespaceSource = fromCache
      ? `const namespace = globalThis[Symbol.for('import-in-the-middle')][${JSON.stringify(cachedNamespaceKey)}](${JSON.stringify(realUrl)})`
      : `import * as namespace from ${JSON.stringify(namespaceUrl)}`

    return `
import { register, ModuleBinder } from ${JSON.stringify(iitmURL)}
${namespaceSource}
${originImports}
${binder}
${reexports}

__binder.flush()

${completeCanonicalWrapper}
register(${JSON.stringify(realUrl)}, __binder, ${JSON.stringify(originalSpecifier)}${bridgeRequire ? ', true' : ''})
`
  }

  /**
   * @param {string} realUrl The original module URL.
   * @param {string} source The original module source.
   * @param {string} originalSpecifier The original import specifier.
   * @returns {string | undefined} Rewritten source.
   */
  function buildInPlaceSource (realUrl, source, originalSpecifier, parsed) {
    if (IN_PLACE_UNSAFE_IDENTIFIER_RE.test(source)) return

    const rewritten = rewriteExports(source, parsed)
    if (rewritten === undefined) return

    let indexParameter = 'index'
    let valueParameter = 'value'
    let hasLiveExports = false
    for (const exported of rewritten.exports) {
      if (exported.mode === 'live') hasLiveExports = true
      if (exported.mode === 'dual') continue
      if (exported.local === indexParameter) indexParameter = '__iitmIndex'
      if (exported.local === valueParameter) valueParameter = '__iitmValue'
    }

    let declarations = ''
    let readCases = ''
    let writeCases = ''
    let exportSpecifiers = ''
    let keys = ''
    let values = ''
    for (let index = 0; index < rewritten.exports.length; index++) {
      const { name, local, mode } = rewritten.exports[index]
      const native = mode !== 'dual'
      const binding = `__iitm${index}`
      if (!native) {
        declarations += declarations === '' ? `${binding} = ${local}` : `, ${binding} = ${local}`
        exportSpecifiers += exportSpecifiers === '' ? `${binding} as ${name}` : `, ${binding} as ${name}`
      }
      if (hasLiveExports) readCases += `    case ${index}: return ${native ? local : binding}\n`
      writeCases += `    case ${index}: ${native ? local : binding} = ${valueParameter}; break\n`
      keys += index === 0 ? JSON.stringify(name) : `, ${JSON.stringify(name)}`
      values += index === 0 ? local : `, ${local}`
    }

    const declarationSource = declarations === '' ? '' : `let ${declarations}\n`
    const readSource = hasLiveExports
      ? `function __iitmRead (${indexParameter}) {
  switch (${indexParameter}) {
${readCases}  }
}
`
      : ''
    const reexports = exportSpecifiers === '' ? '' : `export { ${exportSpecifiers} }\n`
    const read = hasLiveExports ? '__iitmRead' : 'undefined'

    const instrumentedSource = `${rewritten.source}
${declarationSource}${readSource}function __iitmWrite (${indexParameter}, ${valueParameter}) {
  switch (${indexParameter}) {
${writeCases}  }
}
${reexports}${inPlaceBinder}(${JSON.stringify(realUrl)}, ${JSON.stringify(originalSpecifier)}, [${keys}], [${values}], ${read}, __iitmWrite)
`
    return instrumentedSource
  }

  /**
   * @param {string} url A resolved module URL.
   * @returns {Module | undefined} Its require.cache entry, if present.
   */
  function getRequireCached (url) {
    try {
      const cacheKey = url.startsWith('file:') ? fileURLToPath(url) : url
      return requireCache?.[cacheKey]
    } catch {
      return undefined
    }
  }

  /**
   * @param {string} url A resolved module URL.
   * @returns {boolean} Whether require() loaded the module before this import.
   */
  function isRequireCached (url) {
    return getRequireCached(url) !== undefined
  }

  /**
   * Attempts the in-place transform after the parent loader has supplied source.
   *
   * @param {string} realUrl The original module URL.
   * @param {LoadResult} loadedResult The parent loader result.
   * @param {string} originalSpecifier The original import specifier.
   * @returns {{ source: string } | { parsed: EsmParseResult, originalSource: string } | undefined}
   * The transform or reusable source and lexer result.
   */
  function buildInPlaceResult (realUrl, loadedResult, originalSpecifier) {
    if (requiredModules.has(realUrl) || isRequireCached(realUrl) ||
        loadedResult.format !== 'module' || loadedResult.source == null) return

    const source = sourceToString(loadedResult.source)
    const parsed = parseEsm(source)
    const instrumented = buildInPlaceSource(realUrl, source, originalSpecifier, parsed)
    if (instrumented === undefined) return { parsed, originalSource: source }

    specifiers.delete(realUrl)
    canonicalModules.add(realUrl)
    return { source: instrumented }
  }

  /**
   * Reuses the source already loaded for an unsuccessful in-place attempt.
   *
   * @param {string} realUrl The original module URL.
   * @param {LoadResult | undefined} loadedResult The result to reuse once.
   * @param {LoadFunction} load The parent loader.
   * @returns {LoadFunction} A loader compatible with the synchronous driver.
   */
  function reuseLoadedResult (realUrl, loadedResult, load) {
    if (loadedResult === undefined) return load

    let pendingResult = loadedResult
    return function loadOnce (requestedUrl, requestedContext) {
      if (pendingResult !== undefined && requestedUrl === realUrl) {
        const result = pendingResult
        pendingResult = undefined
        return result
      }
      return load(requestedUrl, requestedContext)
    }
  }

  /**
   * Finalizes a successful wrap and builds its module source.
   *
   * @param {string} realUrl The URL of the wrapped module.
   * @param {LoadContext} context Its loader context.
   * @param {string} originalSpecifier The original import specifier.
   * @param {string[] | Map<string, string | StarBinding>} bindings Its exported bindings.
   * @param {string} [namespaceUrl] The URL from which the original namespace is loaded.
   * @param {boolean} [fromCache] Whether to read a preloaded namespace from require.cache.
   * @param {boolean} [bridgeRequire] Whether Hooks may require the pending canonical wrapper.
   */
  function onWrapSuccess (
    realUrl,
    context,
    originalSpecifier,
    bindings,
    namespaceUrl,
    fromCache = false,
    bridgeRequire = false
  ) {
    specifiers.delete(realUrl)
    // context.format is set to 'commonjs' by getCjsExports during processModule.
    if (context.format === 'commonjs') {
      cjsInIitmChain.add(realUrl)
    }
    if (namespaceUrl !== undefined) {
      canonicalModules.add(realUrl)
      canonicalWrappers.add(realUrl)
    }
    return buildWrapperSource(realUrl, bindings, originalSpecifier, namespaceUrl, fromCache, bridgeRequire)
  }

  // Bookkeeping shared by the async and sync wrap paths when `processModule`
  // throws. iitm falls back to the parent loader so the module loads unwrapped
  // (it just can't be Hook'ed) rather than taking down the whole app. We free
  // the specifier entry to avoid a leak, and log because a failure here is
  // usually an iitm bug and would otherwise be very tricky to debug.
  /**
   * @param {string} realUrl The URL whose wrapper could not be built.
   * @param {unknown} cause The parse or wrapper-generation failure.
   */
  function onWrapFailure (realUrl, cause) {
    specifiers.delete(realUrl)
    const err = new Error(`'import-in-the-middle' failed to wrap '${realUrl}'`)
    err.cause = cause
    emitWarning(err)
  }

  /**
   * @param {string} url
   * @param {LoadContext} context
   * @param {(url: string, context?: Partial<LoadContext>) => LoadResult | Promise<LoadResult>} parentGetSource
   */
  async function getSource (url, context, parentGetSource) {
    if (hasIitm(url)) {
      const realUrl = deleteIitm(url)
      const specifierData = specifiers.get(realUrl)
      if (specifierData === undefined) {
        specifiers.delete(url)
        return parentGetSource(url, context)
      }

      let originalSpecifier = specifierData
      let processContext = context
      if (typeof specifierData !== 'string') {
        originalSpecifier = specifierData.specifier
        processContext = { ...context, format: specifierData.format }
      }

      try {
        const { bindings } = await driveAsync(
          processModule({ srcUrl: realUrl, context: processContext }),
          { resolve: cachedResolve, load: parentGetSource }
        )
        return { source: onWrapSuccess(realUrl, processContext, originalSpecifier, bindings) }
      } catch (cause) {
        onWrapFailure(realUrl, cause)
        // Revert back to the non-iitm URL
        url = realUrl
      }
    }

    return parentGetSource(url, context)
  }

  // Synchronous counterpart to `getSource`, for `module.registerHooks`. Drives
  // `processModule` straight through; all bookkeeping and source generation is
  // shared with `getSource`.
  /**
   * @param {string} url
   * @param {LoadContext} context
   * @param {(url: string, context?: Partial<LoadContext>) => LoadResult} nextLoad
   */
  function getSourceSync (url, context, nextLoad) {
    const tagged = hasIitm(url)
    const canonical = !tagged && rewriteExports !== undefined && canRewriteInPlace && specifiers.has(url)
    if (tagged || canonical) {
      const realUrl = tagged ? deleteIitm(url) : url
      const specifierData = specifiers.get(realUrl)
      if (specifierData === undefined) {
        specifiers.delete(url)
        return nextLoad(url, context)
      }

      let originalSpecifier = specifierData
      let processContext = context
      if (typeof specifierData !== 'string') {
        originalSpecifier = specifierData.specifier
        processContext = { ...context, format: specifierData.format }
      }

      try {
        const cachedModule = realUrl.startsWith('file:') ? undefined : getRequireCached(realUrl)
        if (cachedModule !== undefined) {
          const bindings = Object.keys(cachedModule.exports)
          return { source: onWrapSuccess(realUrl, processContext, originalSpecifier, bindings, undefined, true) }
        }

        let loadedResult
        let originalSource
        let parsed
        if (rewriteExports !== undefined && canRewriteInPlace) {
          loadedResult = nextLoad(realUrl, processContext)
          const instrumented = buildInPlaceResult(realUrl, loadedResult, originalSpecifier)
          if (instrumented?.source !== undefined) return instrumented
          originalSource = instrumented?.originalSource
          parsed = instrumented?.parsed
        }

        const load = reuseLoadedResult(realUrl, loadedResult, nextLoad)

        const { bindings } = driveSync(
          processModule({ srcUrl: realUrl, context: processContext, parsed }),
          { resolve: cachedResolve, load }
        )
        const namespaceUrl = canonical ? addIitmOriginal(realUrl) : undefined
        let bridgeRequire = false
        if (canonical && parsed !== undefined && originalSource !== undefined) {
          if (parsed[0].some(record => record.type === 'import-meta')) originalImportMeta.add(realUrl)
          bridgeRequire = canBridgeRequire?.(originalSource, parsed) === true
        }
        return {
          source: onWrapSuccess(
            realUrl,
            processContext,
            originalSpecifier,
            bindings,
            namespaceUrl,
            false,
            bridgeRequire
          )
        }
      } catch (cause) {
        onWrapFailure(realUrl, cause)
        url = realUrl
      }
    }

    return nextLoad(url, context)
  }

  async function load (url, context, parentLoad) {
    if (hasIitm(url)) {
      const result = await getSource(url, context, parentLoad)
      // If wrapping failed, `getSource()` may have fallen back to `parentLoad`,
      // which can legally return `source: null` (e.g. for non-JS formats).
      if (result && typeof result === 'object' && result.source != null) {
        return {
          source: result.source,
          shortCircuit: true,
          format: 'module'
        }
      }

      // Fall back to the parent loader with the original (non-iitm) URL.
      return parentLoad(deleteIitm(url), context)
    }

    // On Node 22+, when a CJS module is loaded through the ESM translator and
    // another loader hook provides its source (instead of leaving source null
    // for Node to read natively), require() calls inside that CJS module for
    // packages using the "module-sync" exports condition fail with
    // ERR_VM_MODULE_LINK_FAILURE. Work around this Node bug by stripping
    // hook-provided source for CJS modules in the synchronous require chain,
    // forcing Node to use its native CJS loader which handles this correctly.
    if (cjsInIitmChain.has(url) && !disableCjsSourceStripping) {
      const result = await parentLoad(url, context)
      if (result.format === 'commonjs' && result.source != null) {
        return {
          format: result.format,
          source: undefined
        }
      }
      return result
    }

    return parentLoad(url, context)
  }

  // Synchronous counterpart to `load`, for `module.registerHooks`. Mirrors the
  // async `load` exactly — wrapping via `getSourceSync` and applying the same
  // CJS-in-iitm-chain source stripping — only without awaiting.
  function loadSync (url, context, nextLoad) {
    if (isIitmOriginal(url)) {
      const realUrl = deleteIitm(url)
      const result = nextLoad(realUrl, context)
      if (result.format !== 'module' || result.source == null) return result

      const source = sourceToString(result.source)
      // The wrapper occupies the canonical URL so the original source uses an
      // internal URL. Hide that implementation detail from import.meta and
      // stack traces without shifting any user-code line.
      const restoreImportMeta = originalImportMeta.delete(realUrl)
        ? `import.meta.url = ${JSON.stringify(realUrl)};`
        : ''
      const hashbangEnd = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0
      return {
        ...result,
        source: source.slice(0, hashbangEnd) + restoreImportMeta + source.slice(hashbangEnd) +
          `\n//# sourceURL=${realUrl}`
      }
    }

    if (hasIitm(url) || (rewriteExports !== undefined && canRewriteInPlace && specifiers.has(url))) {
      const result = getSourceSync(url, context, nextLoad)
      // If wrapping failed, `getSourceSync()` may have fallen back to `nextLoad`,
      // which can legally return `source: null` (e.g. for non-JS formats).
      if (result && typeof result === 'object' && result.source != null) {
        return {
          source: result.source,
          shortCircuit: true,
          format: 'module'
        }
      }

      // Fall back to the parent loader with the original (non-iitm) URL.
      return nextLoad(deleteIitm(url), context)
    }

    if (cjsInIitmChain.has(url) && !disableCjsSourceStripping) {
      const result = nextLoad(url, context)
      if (result.format === 'commonjs' && result.source != null) {
        return {
          format: result.format,
          source: undefined
        }
      }
      return result
    }

    return nextLoad(url, context)
  }

  return { initialize, load, resolve, resolveSync, loadSync, applyOptions }
}
