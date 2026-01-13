// CommonJS module that does not use `exports.foo = ...` style named exports.
// `cjs-module-lexer` should still provide `default` after our `addDefault()`.
module.exports = { a: 1 }
