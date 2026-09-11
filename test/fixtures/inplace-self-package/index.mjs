// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { connect as ownConnect } from 'inplace-self-package'

export function connect () {
  return 'package-connected'
}

export function query () {
  return ownConnect() + ':queried'
}
