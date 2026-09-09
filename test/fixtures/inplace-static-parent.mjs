// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// Parent fixture that statically imports a child. When the parent is
// instrumented in place, its source runs under the `?iitm=true` URL and imports
// the child with a bare specifier; the child must still be wrapped and hookable.
// `readChild` lets a test observe the importer-visible child export through the
// parent, which sees the child's own iitm proxy (a Hook override of the child
// reaches it).
import { childName } from './inplace-static-child.mjs'

export const parentValue = 'parent'
export function readChild () {
  return childName()
}
