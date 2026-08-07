# Changelog

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
