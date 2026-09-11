// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { parseEsm } from './get-esm-exports.mjs'

/** @typedef {ReturnType<typeof parseEsm>} EsmParseResult */

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/
const ASSIGNMENT_RE = /^(?:=(?!=|>)|\+\+|--|\*\*=|<<=|>>>=|>>=|[+\-*/%&|^]=)/
const AWAIT_RE = /\bawait\b/
const MAX_IN_PLACE_SOURCE_LENGTH = 4096
const NON_LINE_BREAK_RE = /[^\r\n]/g
const SUPPORTED_DECLARATIONS = new Set(['const', 'let', 'var', 'function', 'class'])
const TOP_LEVEL_CONDITIONAL_KEYWORDS = new Set(['do', 'else', 'for', 'if', 'while'])

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
 * Finds direct mutable exports whose module-scope writes can be classified
 * without parsing JavaScript scopes.
 *
 * @param {string} source The original module source.
 * @param {EsmParseResult} [parsed] A lexer result already produced for this source.
 * @returns {Set<string> | undefined} Mutable locals safe to rewrite in place.
 */
export function canRewriteEsmExportsInPlace (source, parsed) {
  if (source.length > MAX_IN_PLACE_SOURCE_LENGTH) return

  const [imports, records] = parsed ?? parseEsm(source)
  if (records.length === 0) return
  const declarations = new Map()

  for (const record of records) {
    if (record.typeOnly || record.type !== 'direct') return

    const afterExport = skipSpace(source, record.exportStart + 6)
    if (source.charCodeAt(afterExport) === 0x7b /* { */) return
    if (record.name === 'default') continue

    let keywordStart = afterExport
    let keywordEnd = skipToken(source, keywordStart)
    if (source.slice(keywordStart, keywordEnd) === 'async') {
      keywordStart = skipSpace(source, keywordEnd)
      keywordEnd = skipToken(source, keywordStart)
    }

    const keyword = source.slice(keywordStart, keywordEnd)
    if (keyword === 'let' || keyword === 'var') {
      if (!isIdentifierStart(source.charCodeAt(skipSpace(source, keywordEnd))) ||
          !isIdentifier(record.localName) || record.localName !== record.name) return
      declarations.set(record.localName, record.localStart)
    }
  }

  if (declarations.size === 0) {
    if (imports.some(record => record.type === 'static' || record.type === 'dynamic')) return
    return new Set()
  }
  return findTopLevelMutations(source, declarations)
}

/**
 * @typedef {object} ExportPlan
 * @property {string} name The exported name.
 * @property {string} local The module-local binding.
 * @property {'dual' | 'live'} mode How Hook reads and writes reach the binding.
 */

/**
 * Rewrites direct declaration exports for the synchronous loader path.
 *
 * @param {string} source The original module source.
 * @param {EsmParseResult} [parsed] A lexer result already produced for this source.
 * @param {Set<string>} [mutableExports] Mutable locals proven safe for in-place rewriting.
 * @returns {{ source: string, exports: ExportPlan[] } | undefined}
 */
export function rewriteEsmExports (source, parsed, mutableExports) {
  if (!source.includes('export')) return

  const parsedResult = parsed ?? parseEsm(source)
  const [imports, records] = parsedResult
  if (records.length === 0) return

  const exports = []
  const exportedNames = new Set()
  const constLocals = new Map()
  let editedStatements
  const edits = []
  let defaults
  let hasDualExports = false

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
      if (!addExport(exports, exportedNames, 'default', record.localName, 'dual')) return
      hasDualExports = true
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
    if ((keyword === 'const' || keyword === 'let' || keyword === 'var') &&
        !isIdentifierStart(source.charCodeAt(skipSpace(source, keywordEnd)))) return

    const live = keyword === 'let' || keyword === 'var'
    if (live && mutableExports !== undefined && !mutableExports.has(record.localName)) return
    const mode = live ? 'live' : 'dual'
    if (!addExport(exports, exportedNames, record.name, record.localName, mode)) return
    if (!live) hasDualExports = true
    if (keyword === 'const') constLocals.set(record.localName, statementStart)

    if (!live && !editedStatements?.has(statementStart)) {
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
      hasDualExports = true
      edits.push({ start: record.exportStart, end: statementEnd })
    }
    /**
     * @param {{ start: number }} left A source edit.
     * @param {{ start: number }} right A source edit.
     */
    edits.sort((left, right) => left.start - right.start)
  }

  if (hasDualExports && imports.some(record => record.type === 'static' || record.type === 'dynamic')) return
  return { source: edits.length === 0 ? source : applyEdits(source, edits), exports }
}

/**
 * @param {ExportPlan[]} exports The accumulated export plan.
 * @param {Set<string>} exportedNames The exported names already present.
 * @param {string} name The exported name.
 * @param {string} local The module-local binding.
 * @param {'dual' | 'live'} mode How Hook reads and writes reach the binding.
 * @returns {boolean} Whether the name was added.
 */
function addExport (exports, exportedNames, name, local, mode) {
  if (exportedNames.has(name)) return false
  exportedNames.add(name)
  exports.push({ name, local, mode })
  return true
}

/**
 * @param {string} source The source text.
 * @param {Map<string, number>} declarations Mutable local declarations and their offsets.
 * @returns {Set<string> | undefined} Locals with a recognized top-level write.
 */
function findTopLevelMutations (source, declarations) {
  const mutations = new Set()
  let braceDepth = 0
  let bracketDepth = 0
  let parenthesisDepth = 0
  let index = source.startsWith('#!') ? skipLine(source, 2) : 0

  while (index < source.length) {
    const code = source.charCodeAt(index)

    if (code === 0x27 /* ' */ || code === 0x22 /* " */) {
      index = skipQuoted(source, index, code)
      if (index === -1) return
      continue
    }
    if (code === 0x60 /* ` */ || code === 0x5c /* \\ */) return

    if (code === 0x2f /* / */) {
      const next = source.charCodeAt(index + 1)
      if (next === 0x2f /* / */) {
        index = skipLine(source, index + 2)
        continue
      }
      if (next === 0x2a /* * */) {
        const end = source.indexOf('*/', index + 2)
        if (end === -1) return
        index = end + 2
        continue
      }
      return
    }

    if (code === 0x7b /* { */) {
      braceDepth++
      index++
      continue
    }
    if (code === 0x7d /* } */) {
      braceDepth--
      index++
      continue
    }
    if (code === 0x5b /* [ */) {
      bracketDepth++
      index++
      continue
    }
    if (code === 0x5d /* ] */) {
      bracketDepth--
      index++
      continue
    }
    if (code === 0x28 /* ( */) {
      parenthesisDepth++
      index++
      continue
    }
    if (code === 0x29 /* ) */) {
      parenthesisDepth--
      index++
      continue
    }
    if (code === 0x3d /* = */ && source.charCodeAt(index + 1) === 0x3e /* > */) return

    if (braceDepth === 0 && bracketDepth === 0 && parenthesisDepth === 0 &&
        (code === 0x3f /* ? */ ||
         (code === 0x26 /* & */ && source.charCodeAt(index + 1) === code) ||
         (code === 0x7c /* | */ && source.charCodeAt(index + 1) === code))) return

    if (!isIdentifierStart(code)) {
      index++
      continue
    }

    const start = index++
    while (index < source.length && isIdentifierPart(source.charCodeAt(index))) index++

    if (braceDepth !== 0 || bracketDepth !== 0 || parenthesisDepth !== 0) continue

    const name = source.slice(start, index)
    const previous = previousNonSpace(source, start)
    if (previous !== -1 && source.charCodeAt(previous) === 0x2e /* . */) continue
    if (TOP_LEVEL_CONDITIONAL_KEYWORDS.has(name)) return

    const declarationStart = declarations.get(name)
    if (declarationStart === undefined || declarationStart === start) continue

    const assignmentStart = skipSpace(source, index)
    if (ASSIGNMENT_RE.test(source.slice(assignmentStart))) {
      mutations.add(name)
    } else if (previous > 0) {
      const prefix = source.slice(previous - 1, previous + 1)
      if ((prefix === '++' || prefix === '--') && isPrefixBoundary(source, previous - 1)) {
        mutations.add(name)
      }
    }

    if (mutations.size === declarations.size) return mutations
  }
}

/**
 * @param {number} code A UTF-16 code unit.
 * @returns {boolean} Whether it starts an ASCII identifier.
 */
function isIdentifierStart (code) {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x5f || code === 0x24
}

/**
 * @param {number} code A UTF-16 code unit.
 * @returns {boolean} Whether it continues an ASCII identifier.
 */
function isIdentifierPart (code) {
  return isIdentifierStart(code) || (code >= 0x30 && code <= 0x39)
}

/**
 * @param {string} source The source text.
 * @param {number} start The opening quote offset.
 * @param {number} quote The quote code unit.
 * @returns {number} The first offset after the string, or -1 when unterminated.
 */
function skipQuoted (source, start, quote) {
  let index = start + 1
  while (index < source.length) {
    const code = source.charCodeAt(index++)
    if (code === quote) return index
    if (code === 0x5c /* \\ */) index++
  }
  return -1
}

/**
 * @param {string} source The source text.
 * @param {number} from The first offset after the line marker.
 * @returns {number} The first offset after the line break or the source end.
 */
function skipLine (source, from) {
  let index = from
  while (index < source.length) {
    const code = source.charCodeAt(index++)
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) break
  }
  return index
}

/**
 * @param {string} source The source text.
 * @param {number} from The offset before which to search.
 * @returns {number} The previous non-whitespace offset, or -1.
 */
function previousNonSpace (source, from) {
  let index = from - 1
  while (index >= 0) {
    const code = source.charCodeAt(index)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return index
    index--
  }
  return -1
}

/**
 * @param {string} source The source text.
 * @param {number} start The prefix update offset.
 * @returns {boolean} Whether the prefix begins a top-level expression.
 */
function isPrefixBoundary (source, start) {
  const previous = previousNonSpace(source, start)
  if (previous === -1) return true
  return source.charCodeAt(previous) === 0x3b /* ; */
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
  while (index < source.length && isIdentifierPart(source.charCodeAt(index))) index++
  return index
}
