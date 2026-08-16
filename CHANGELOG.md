# Changelog

## Unreleased

- Persisted immutable per-message wake intent so outbox flushes, restarts,
  explicit retries, and message queue adapters cannot upgrade `wake: false`.
- Kept delivered wake-requested messages durably wake-pending across sender
  restarts, retrying the wake without another rsync until acknowledgement.
- Added a bounded, token-fenced peer wake runner with distinct started/busy/
  failed launch results, structured message acceptance, outside-sandbox
  acknowledgement, and TERM/KILL cleanup for hung receivers.

## 0.3.9 - 2026-08-15

- Enforced configured inbound and outbound peer-tool allowlists and peer
  command flags at both sides of the transport boundary.
- Made controller inbound and worker outbound peer-tool lists empty by default
  in controller-worker mode while preserving symmetric compatibility.
- Rejected malformed role, directional feature, and peer-tool configuration at
  startup, with side-effect and real dispatch coverage for the boundary.

## 0.3.8 - 2026-08-15

- Corrected full-package provenance verification to compare the complete file
  set in one deterministic order, including mixed-case root and nested paths.

## 0.3.7 - 2026-08-15

- Required recorded owner authorization for trainer start, stop, and package
  lifecycle operations while reusing the active owner instruction rather than
  adding another approval prompt.
- Added fail-closed source-lineage and content-hashed package provenance so an
  installed revision must be an exact clean Git commit descended from the last
  public release line.
- Defined a single-PR release-coordinator workflow for multiple maintainers;
  production history and release tags are immutable.

## 0.3.6 - 2026-08-07

- Preserved settled trainer lifecycle state during reboot reconciliation.
- Allowed an unchanged, explicitly paused queued job to resume while retaining
  revision-bound authorization and refusing an ineligible ready job.
- Materialized every supported operational environment default during upgrades
  and failed the release gate when a schema key is absent from both the public
  example and the explicit internal-key classification.
- Wired controller activation to HawkSpan's built-in packet receiver, admitted
  only digest-bound automatic return artifacts, and removed the hidden runtime
  dependency on the retired `application-workflows` intake path.
- Treated a currently running periodic launchd service as healthy instead of
  requiring it to finish before startup readiness could pass.
- Made preserved packet staging idempotent so periodic receiver runs reuse the
  existing digest-bound receipt instead of copying or acknowledging it again.

## 0.3.5 - 2026-08-07

- Copied fixed validation and ControlNet inputs into each immutable staged job,
  included their hashes in revision identity, and rejected missing inputs at
  readiness instead of after training.
- Added exact-revision package-only recovery for a completed run whose automatic
  return packet failed, without retraining or discarding checkpoints.

## 0.3.4 - 2026-08-06

- Cleared SimpleTuner's current-target telemetry when an operator skips that
  target, whether the scheduler stored the target name or queue-item ID.

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
