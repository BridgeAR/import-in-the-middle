// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { Late, initializeLate } from './inplace-live-bindings.mjs?consumer'

initializeLate()

export class Sub extends Late {}
