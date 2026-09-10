// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

export let state = 'initial'
// eslint-disable-next-line no-var -- issue #280 uses a late-initialized var export
export var Late

export function readState () {
  return state
}

export function updateState (value) {
  state = value
}

export function initializeLate () {
  Late = class Late {}
}
