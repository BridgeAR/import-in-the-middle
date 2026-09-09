// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// A module whose exports are all direct declaration forms handled in place.
// Used
// to assert dual-cell parity (a Hook override is visible to importers but not to
// the module's own internal reads) without any wrapper fallback.
export const foo = 42

export function greet () {
  // Internal reference: reads the module's own `foo`, not the export cell.
  return `hi ${foo}`
}

export async function load () {
  return 'loaded'
}

export class Counter {
  #n = 0
  increment () {
    return ++this.#n
  }
}

export default function main () {
  return greet()
}
