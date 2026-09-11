// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// Child fixture statically imported by inplace-static-parent.mjs. Instrumenting
// the parent in place must not stop this child from being instrumented and
// hooked: it is a separate module, reached through a bare specifier from an
// in-place parent.
export const childValue = 'child'
export function childName () {
  return childValue
}
