import * as lib from '../fixtures/reexport-same-source.mjs'
import { strictEqual } from 'assert'
import Hook from '../../index.js'

// `val` reaches the entry module through two `export *` chains that both bottom
// out at the same leaf module, so per ECMAScript ResolveExport it is one binding
// and stays exported (issue #171). The previous dedup treated any name from two
// `*` re-exports as ambiguous and dropped it. The exported value is wired up by
// the stacked wrapper-identity fix; this test pins the membership half.
Hook((exports, name) => {
  if (name.includes('reexport-same-source.mjs')) {
    strictEqual('val' in exports, true)
  }
})

strictEqual('val' in lib, true)
