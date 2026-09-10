// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { parseEsm } from './get-esm-exports.mjs'

/** @typedef {ReturnType<typeof parseEsm>} EsmParseResult */

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/
const AWAIT_RE = /\bawait\b/
const NON_LINE_BREAK_RE = /[^\r\n]/g
const SUPPORTED_DECLARATIONS = new Set(['const', 'let', 'var', 'function', 'class'])

/**
 * A temporary require.cache entry is safe only when this module cannot be an
 * async module itself or through a static dependency.
 *
 * @param {string} source The original module source.
 * @param {EsmParseResult} [parsed] A lexer result already produced for this source.
 * @returns {boolean} Whether a re-entrant require may use the cache bridge.
 */
export function canUseRequireCacheBridge (source, parsed) {
  return !AWAIT_RE.test(source) &&
    !(parsed ?? parseEsm(source))[0].some(record => record.type === 'static')
}

/**
 * @typedef {object} ExportPlan
 * @property {string} name The exported name.
 * @property {string} local The module-local binding.
 * @property {boolean} live Whether the original mutable export remains native.
 */

/**
 * Rewrites direct declaration exports for the synchronous loader path.
 *
 * @param {string} source The original module source.
 * @param {EsmParseResult} [parsed] A lexer result already produced for this source.
 * @returns {{ source: string, exports: ExportPlan[] } | undefined}
 */
export function rewriteEsmExports (source, parsed) {
  if (!source.includes('export')) return

  const parsedResult = parsed ?? parseEsm(source)
  const [imports, records] = parsedResult
  // Requiring an in-place module while its Hook runs needs a temporary cache
  // bridge. Keep async dependency graphs on the wrapper path so that bridge
  // cannot hide Node's ERR_REQUIRE_ASYNC_MODULE semantics.
  if (imports.length !== 0 || !canUseRequireCacheBridge(source, parsedResult) || records.length === 0) return

  const exports = []
  const exportedNames = new Set()
  const constLocals = new Map()
  const editedStatements = new Set()
  const edits = []
  let defaults

  for (const record of records) {
    if (record.typeOnly || record.type !== 'direct') return

    const statementStart = record.exportStart
    const afterExport = skipSpace(source, statementStart + 6)

    if (source.charCodeAt(afterExport) === 0x7b /* { */) return

    if (record.name === 'default') {
      if (record.localName === undefined) {
        (defaults ??= []).push(record)
        continue
      }

      if (!isIdentifier(record.localName)) return
      const defaultEnd = skipToken(source, afterExport)
      if (source.slice(afterExport, defaultEnd) !== 'default') return
      const declarationStart = skipSpace(source, defaultEnd)
      if (!addExport(exports, exportedNames, 'default', record.localName, false)) return
      edits.push({ start: statementStart, end: declarationStart })
      continue
    }

    if (!isIdentifier(record.localName) || !isIdentifier(record.name) || record.localName !== record.name) return

    let keywordStart = afterExport
    let keywordEnd = skipToken(source, keywordStart)
    if (source.slice(keywordStart, keywordEnd) === 'async') {
      keywordStart = skipSpace(source, keywordEnd)
      keywordEnd = skipToken(source, keywordStart)
    }
    const keyword = source.slice(keywordStart, keywordEnd)
    if (!SUPPORTED_DECLARATIONS.has(keyword)) return
    // A native cell is the only parser-free way to preserve later assignments.
    // Hook writes therefore also affect the module's own reads of mutable exports.
    const live = keyword === 'let' || keyword === 'var'
    if (!addExport(exports, exportedNames, record.name, record.localName, live)) return
    if (keyword === 'const') constLocals.set(record.localName, statementStart)

    if (!live && !editedStatements.has(statementStart)) {
      editedStatements.add(statementStart)
      edits.push({ start: statementStart, end: afterExport })
    }
  }

  if (defaults !== undefined) {
    for (const record of defaults) {
      const localStart = skipSpace(source, record.end)
      const localEnd = skipToken(source, localStart)
      const local = source.slice(localStart, localEnd)
      if (!isIdentifier(local)) return

      const afterLocal = skipSpace(source, localEnd)
      let statementEnd
      if (source.charCodeAt(afterLocal) === 0x3b /* ; */) {
        statementEnd = afterLocal + 1
      } else if (afterLocal === source.length) {
        statementEnd = localEnd
      } else {
        return
      }

      const declarationStart = constLocals.get(local)
      if (declarationStart === undefined || declarationStart > record.exportStart) return
      if (!addExport(exports, exportedNames, 'default', local, false)) return
      edits.push({ start: record.exportStart, end: statementEnd })
    }
  }

  return { source: applyEdits(source, edits), exports }
}

/**
 * @param {ExportPlan[]} exports The accumulated export plan.
 * @param {Set<string>} exportedNames The exported names already present.
 * @param {string} name The exported name.
 * @param {string} local The module-local binding.
 * @param {boolean} live Whether the original mutable export remains native.
 * @returns {boolean} Whether the name was added.
 */
function addExport (exports, exportedNames, name, local, live) {
  if (exportedNames.has(name)) return false
  exportedNames.add(name)
  exports.push({ name, local, live })
  return true
}

/**
 * @param {string | undefined} name A lexer-reported binding name.
 * @returns {boolean} Whether the name can be emitted without escaping.
 */
function isIdentifier (name) {
  return name !== undefined && IDENTIFIER_RE.test(name)
}

/**
 * @param {string} source The original module source.
 * @param {Array<{ start: number, end: number }>} edits Non-overlapping source edits.
 * @returns {string} The rewritten source.
 */
function applyEdits (source, edits) {
  /**
   * @param {{ start: number }} left A source edit.
   * @param {{ start: number }} right A source edit.
   */
  edits.sort((left, right) => left.start - right.start)
  let rewritten = ''
  let cursor = 0
  for (const edit of edits) {
    rewritten += source.slice(cursor, edit.start)
    rewritten += source.slice(edit.start, edit.end).replace(NON_LINE_BREAK_RE, ' ')
    cursor = edit.end
  }
  return rewritten + source.slice(cursor)
}

/**
 * @param {string} source The source text.
 * @param {number} from The start index.
 * @returns {number} The first non-whitespace index.
 */
function skipSpace (source, from) {
  let index = from
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
    index++
  }
  return index
}

/**
 * @param {string} source The source text.
 * @param {number} from The token start.
 * @returns {number} The index after the identifier token.
 */
function skipToken (source, from) {
  let index = from
  while (index < source.length) {
    const code = source.charCodeAt(index)
    const isWord = (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x5f || code === 0x24
    if (!isWord) break
    index++
  }
  return index
}
