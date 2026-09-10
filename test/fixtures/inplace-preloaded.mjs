// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

globalThis.__iitmPreloadedEvaluations = (globalThis.__iitmPreloadedEvaluations ?? 0) + 1

export const instance = {}
export const evaluations = globalThis.__iitmPreloadedEvaluations
export default instance
