// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

export let state
state = 'initial'
export let value
value = 41
export let index
index = 40
// eslint-disable-next-line no-var -- issue #280 uses a late-initialized var export
export var Late
Late = undefined

export function readState () {
  return state
}

export function selfReferenced () {
  return selfReferenced
}

export function updateState (value) {
  state = value
}

export function updateCollisionExports () {
  value++
  index++
}

export function initializeLate () {
  Late = class Late {}
}
