// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// The star re-export target is a bare specifier that cannot be resolved. While
// collecting exports, IITM yields a RESOLVE operation for it; the resolver
// throws, and that error has to be fed back into the loader generator (drive
// error handling in lib/io.mjs) before surfacing to the importer.
export * from 'iitm-test-nonexistent-star-target'
