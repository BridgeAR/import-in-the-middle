// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { parseEsm } from './get-esm-exports.mjs'

/** @typedef {ReturnType<typeof parseEsm>} EsmParseResult */

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/
const AWAIT_RE = /\bawait\b/
const NON_LINE_BREAK_RE = /[^\r\n]/g
const REFERENCE_SCAN_THRESHOLD = 64
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
 * @property {'dual' | 'native' | 'live'} mode How Hook reads and writes reach the binding.
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
  for (const imported of imports) {
    if (imported.type !== 'import-meta') return
  }
  if (!canUseRequireCacheBridge(source, parsedResult) || records.length === 0) return

  const exports = []
  const exportedNames = new Set()
  const constLocals = new Map()
  let editedStatements
  const edits = []
  let defaults
  let canUseLocalCells = !source.includes('\\u') && !source.includes('eval')
  const referencedLocals = canUseLocalCells && records.length > REFERENCE_SCAN_THRESHOLD
    ? findReferencedLocals(source, records)
    : undefined

  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex]
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
      const native = canUseLocalCells && (referencedLocals === undefined
        ? isOnlyOccurrence(source, record.localName, record.localStart)
        : !referencedLocals.has(record.localName))
      if (!native && referencedLocals === undefined) canUseLocalCells = false
      if (!addExport(exports, exportedNames, 'default', record.localName, native ? 'native' : 'dual')) return
      if (!native) edits.push({ start: statementStart, end: declarationStart })
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
    const sharedStatement = records[recordIndex - 1]?.exportStart === statementStart ||
      records[recordIndex + 1]?.exportStart === statementStart
    let native = live
    if (!live && !sharedStatement && canUseLocalCells) {
      native = referencedLocals === undefined
        ? isOnlyOccurrence(source, record.localName, record.localStart)
        : !referencedLocals.has(record.localName)
      if (!native && referencedLocals === undefined) canUseLocalCells = false
    }
    const mode = live ? 'live' : native ? 'native' : 'dual'
    if (!addExport(exports, exportedNames, record.name, record.localName, mode)) return
    if (keyword === 'const') constLocals.set(record.localName, statementStart)

    if (native && keyword === 'const') {
      edits.push({ start: keywordStart, end: keywordEnd, replacement: 'let  ' })
    } else if (!native && !editedStatements?.has(statementStart)) {
      (editedStatements ??= new Set()).add(statementStart)
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
      if (!addExport(exports, exportedNames, 'default', local, 'dual')) return
      edits.push({ start: record.exportStart, end: statementEnd })
    }
    /**
     * @param {{ start: number }} left A source edit.
     * @param {{ start: number }} right A source edit.
     */
    edits.sort((left, right) => left.start - right.start)
  }

  return { source: edits.length === 0 ? source : applyEdits(source, edits), exports }
}

/**
 * @param {ExportPlan[]} exports The accumulated export plan.
 * @param {Set<string>} exportedNames The exported names already present.
 * @param {string} name The exported name.
 * @param {string} local The module-local binding.
 * @param {'dual' | 'native' | 'live'} mode How Hook reads and writes reach the binding.
 * @returns {boolean} Whether the name was added.
 */
function addExport (exports, exportedNames, name, local, mode) {
  if (exportedNames.has(name)) return false
  exportedNames.add(name)
  exports.push({ name, local, mode })
  return true
}

/**
 * Counts possible references without parsing scopes. Identifiers in comments,
 * strings, and property names deliberately select the dual-cell path.
 *
 * @param {string} source The source text.
 * @param {EsmParseResult[1]} records The lexer-reported exports.
 * @returns {Set<string>} Locals with another possible identifier occurrence.
 */
function findReferencedLocals (source, records) {
  const declarationStarts = new Map()
  for (const record of records) {
    if (record.type === 'direct' && isIdentifier(record.localName)) {
      declarationStarts.set(record.localName, record.localStart)
    }
  }

  const referenced = new Set()
  let index = 0
  while (index < source.length && referenced.size < declarationStarts.size) {
    const code = source.charCodeAt(index)
    const isIdentifierStart = (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
      code === 0x5f || code === 0x24
    if (!isIdentifierStart) {
      index++
      continue
    }

    const start = index++
    while (index < source.length) {
      const part = source.charCodeAt(index)
      const isIdentifierPart = (part >= 0x61 && part <= 0x7a) || (part >= 0x41 && part <= 0x5a) ||
        (part >= 0x30 && part <= 0x39) || part === 0x5f || part === 0x24
      if (!isIdentifierPart) break
      index++
    }

    const name = source.slice(start, index)
    const declarationStart = declarationStarts.get(name)
    if (declarationStart !== undefined && declarationStart !== start) {
      referenced.add(name)
    }
  }
  return referenced
}

/**
 * @param {string} source The source text.
 * @param {string} name The identifier to find.
 * @param {number} declarationStart Its declaration offset.
 * @returns {boolean} Whether the declaration is its only textual occurrence.
 */
function isOnlyOccurrence (source, name, declarationStart) {
  return source.indexOf(name) === declarationStart && source.indexOf(name, declarationStart + name.length) === -1
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
 * @param {Array<{ start: number, end: number, replacement?: string }>} edits Non-overlapping source edits.
 * @returns {string} The rewritten source.
 */
function applyEdits (source, edits) {
  let rewritten = ''
  let cursor = 0
  for (const edit of edits) {
    rewritten += source.slice(cursor, edit.start)
    rewritten += edit.replacement ?? source.slice(edit.start, edit.end).replace(NON_LINE_BREAK_RE, ' ')
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
