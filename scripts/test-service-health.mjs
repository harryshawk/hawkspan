#!/usr/bin/env node

import assert from "node:assert/strict";
import { periodicServiceHealthy } from "./service-health.mjs";

assert.equal(periodicServiceHealthy({ loaded: true, pid: 42, last_status: -15 }), true);
assert.equal(periodicServiceHealthy({ loaded: true, pid: null, last_status: 0 }), true);
assert.equal(periodicServiceHealthy({ loaded: false, pid: null, last_status: 0 }), false);
assert.equal(periodicServiceHealthy({ loaded: true, pid: null, last_status: 1 }), false);

process.stdout.write("periodic service health tests passed\n");
