// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// Importing a module whose star re-export target cannot be resolved drives the
// asynchronous loader generator's error handling: the RESOLVE operation rejects
// and the rejection is thrown back into the generator (lib/io.mjs driveAsync)
// before surfacing to the importer.

import Hook from '../../index.js'
import { rejects } from 'assert'

const hook = new Hook((exports) => {})

await rejects(
  import('../fixtures/star-export-unresolvable.mjs'),
  /iitm-test-nonexistent-star-target/
)

hook.unhook()
