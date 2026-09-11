// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// eslint-disable-next-line prefer-const -- the fixture distinguishes a binding write from a same-name property write
export let value = 1
const holder = { value: 2 }
holder.value = 3

export function readValue () {
  return value
}
