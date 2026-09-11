// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// The module itself uses an identifier in iitm's injected `__iitm*` namespace.
// The in-place transform must detect this and bail to the wrapper rather than
// emit colliding declarations; the export must still work and be hookable.
/* eslint-disable camelcase */
const __iitmExt_foo = 'user-owned'

export function value () {
  return __iitmExt_foo
}
/* eslint-enable camelcase */

export const label = 'collision-fixture'
