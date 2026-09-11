// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

import { strictEqual } from 'node:assert/strict'

import { sourceToString } from '../../lib/get-exports.mjs'

strictEqual(sourceToString('source'), 'source')
strictEqual(sourceToString(Buffer.from('buffer')), 'buffer')

const bytes = Buffer.from('xxviewxx')
strictEqual(sourceToString(new Uint8Array(bytes.buffer, bytes.byteOffset + 2, 4)), 'view')
strictEqual(sourceToString(Uint8Array.from(Buffer.from('array-buffer')).buffer), 'array-buffer')
