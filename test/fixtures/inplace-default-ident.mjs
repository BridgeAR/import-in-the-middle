// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// The default snapshots an inline exported const, so the transform can publish
// both names without moving the snapshot past a reassignment.
export const greet = () => {
  return 'hi'
}

export const version = '1.0.0'

export default greet
