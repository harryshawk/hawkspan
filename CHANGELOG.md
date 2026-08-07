# Changelog

## 0.3.3 - 2026-08-06

- Serialized each complete SimpleTuner scheduler invocation from candidate
  selection through trainer launch so overlapping launchd invocations cannot
  start competing queue items.
- Added a real cross-process regression test that invokes the scheduler twice
  concurrently and requires exactly one trainer adapter call.

## 0.3.2 - 2026-08-06

- Enforced the durable `training` job contract both when a SimpleTuner item is
  admitted and again immediately before scheduler launch.
- Allowed additional immutable jobs to enter the queue while one trainer is
  active, while preserving single-trainer execution.
- Rejected duplicate scheduler targets and mismatched authorization targets.
- Kept successfully launched trainers in truthful `running` telemetry instead
  of recording a premature finish time and exit code.
- Restricted runtime staging and revision hashing to training images and target
  captions, excluding generated cache metadata and conditioning sidecars from
  prior runs.
- Scoped checkpoint-retention health to targets registered in the sole live
  scheduler while still reporting the size of the historical manifest.
- Split successful training return from terminal validation: M4 first returns
  an immutable training packet and releases the trainer slot while the same
  job remains `awaiting-validation`; only the distinct validated packet and
  receiver-confirmed receipt complete the lifecycle.
- Reused the original durable `training` job for final package control instead
  of requiring a separate packaging job identity.

## 0.3.1 - 2026-08-06

- Migrated explicitly retired environment variables during release activation
  instead of rejecting legitimate upgrades before migration.
- Restored the prior environment, configuration, launchd files, stable link,
  and installed authority when release publication fails.

## 0.3.0 - 2026-08-06

- Documented standalone HawkSpan operation and the optional Codex Personal
  plugin mode, including their advantages, tradeoffs, and shared runtime.
- Clarified that the Codex Personal plugin and HawkSpan application plugins are
  separate extension mechanisms.

## 0.2.0 - 2026-08-06

- Added one durable SimpleTuner lifecycle queue spanning training, packaging,
  verified return, receipt confirmation, and completion.
- Added user-created durable queues for messages, artifacts, commands, and
  registered application tools, with atomic batches and operator controls.
- Added bounded application-level route retries that preserve a complete
  Ethernet fallback attempt within the configured cycle deadline.
- Added one installed-release authority for configuration, peer discovery,
  startup, and all five HawkSpan services.
- Added crash-safe SQLite cross-process state locks, reboot reconciliation, and
  receiver-confirmed automatic package return.
- Added the complete release gate, queue operator skill, link-log skill, and
  research-backed queue/network review.

## 0.1.0

The original public HawkSpan release remains available as `v0.1.0` and is not
replaced or rewritten by the 0.2.0 release.
