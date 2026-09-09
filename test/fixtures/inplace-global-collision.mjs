// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

const globalThis = { value: 'local-global' }
const Symbol = { for: () => 'local-symbol' }

export function value () {
  return `${globalThis.value}:${Symbol.for()}`
}

export const label = 'global-collision-fixture'
