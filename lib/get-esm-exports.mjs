'use strict'

import { initSync, parse } from 'es-module-lexer'

let lexerInitialized = false

// es-module-lexer is backed by WebAssembly. `initSync` compiles it up front so
// `parse` can run inside synchronous loader hooks (`module.registerHooks`) as
// well as the off-thread loader; it is a one-time cost on the first ESM module
// either way.
function ensureLexerInitialized () {
  if (!lexerInitialized) {
    initSync()
    lexerInitialized = true
  }
}

// es-module-lexer reports a bare `export * from <mod>` only as an import with no
// matching export entry, indistinguishable from `import <mod>` except by the
// statement text. This matches that text to rewrite it as the transitive
// `* from <specifier>` marker the interpreting code recognizes. `export * as ns
// from` binds a real name and is reported as a normal export, so it must not
// match here. `GAP` allows whitespace and comments between the tokens, the way
// the parser does (e.g. `export /* c */ * from`).
const GAP = '(?:\\s|/\\*[^]*?\\*/|//[^\\n]*\\n)*'
const STAR_REEXPORT = new RegExp(`^export${GAP}\\*${GAP}from`)

/**
 * Lexes ESM source code with es-module-lexer and builds a list of exported
 * identifiers. In the baseline case the list is the simple identifier names as
 * written in the source. There is one special case:
 *
 * When an `export * from './foo.js'` line is encountered it is rewritten as
 * `* from ./foo.js`. This lets the interpreting code recognize a transitive
 * export and recursively parse the indicated module. The returned identifier
 * list will have "* from ./foo.js" as an item.
 *
 * @param {string} moduleSource The source code of the module to lex.
 * @returns {Set<string>} The identifiers exported by the module along with any
 * custom directives.
 */
export default function getEsmExports (moduleSource) {
  return lexEsm(moduleSource).exportNames
}

/**
 * Lexes ESM source code once and reports both the exported identifiers and
 * whether the source uses ESM syntax. Sharing a single `parse` lets the
 * unknown-format path in `getExports` decide between ESM and CommonJS without a
 * second pass over the source.
 *
 * `hasModuleSyntax` is es-module-lexer's own signal: static `import`/`export`
 * and `import.meta` set it, while a lone dynamic `import(...)` (valid in CJS)
 * does not.
 *
 * @param {string} moduleSource The source code of the module to lex.
 * @returns {{ exportNames: Set<string>, hasModuleSyntax: boolean }}
 */
export function lexEsm (moduleSource) {
  ensureLexerInitialized()
  const exportNames = new Set()
  const [imports, exports, , hasModuleSyntax] = parse(moduleSource)

  for (const exported of exports) {
    exportNames.add(exported.n)
  }

  // Bare `export * from <mod>` re-exports report no export name; reconstruct
  // the transitive marker from the import statement that carries the specifier.
  for (const imported of imports) {
    if (STAR_REEXPORT.test(moduleSource.slice(imported.ss, imported.se))) {
      exportNames.add(`* from ${imported.n}`)
    }
  }

  return { exportNames, hasModuleSyntax }
}
