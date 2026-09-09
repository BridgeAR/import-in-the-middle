// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

export function connect () {
  return 'dynamic-connected'
}

export async function query () {
  const { connect } = await import('./inplace-self-dynamic.mjs')
  return connect() + ':queried'
}
