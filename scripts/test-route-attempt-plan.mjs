#!/usr/bin/env node

import assert from "node:assert/strict";
import { operationAttemptFits, routeAttemptPlan } from "./route-attempt-plan.mjs";

assert.deepEqual(
  routeAttemptPlan(["thunderbolt", "ethernet"], [2000, 5000]),
  [
    { host: "thunderbolt", cycle: 1, delay_ms: 0, route_index: 0, is_last_route: false },
    { host: "thunderbolt", cycle: 2, delay_ms: 2000, route_index: 0, is_last_route: false },
    { host: "thunderbolt", cycle: 3, delay_ms: 5000, route_index: 0, is_last_route: false },
    { host: "ethernet", cycle: 1, delay_ms: 0, route_index: 1, is_last_route: true },
    { host: "ethernet", cycle: 2, delay_ms: 2000, route_index: 1, is_last_route: true },
    { host: "ethernet", cycle: 3, delay_ms: 5000, route_index: 1, is_last_route: true },
  ],
);

assert.equal(operationAttemptFits({
  remainingMs: 43000,
  delayMs: 20000,
  attemptTimeoutMs: 15000,
  isLastRoute: false,
}), false, "a primary retry must not consume the complete fallback-attempt reserve");
assert.equal(operationAttemptFits({
  remainingMs: 43000,
  delayMs: 0,
  attemptTimeoutMs: 15000,
  isLastRoute: true,
}), true, "the reserved fallback attempt must fit in the same cycle");

process.stdout.write("route attempt plan tests passed\n");
