# Release Flow

## 2026-08-06 - HawkSpan 0.3.2 queue-admission candidate

- Request: Exercise multiple real 100-step LoRA plus ControlNet jobs and queue
  controls through HawkSpan.
- Source branch: `fix/atomic-upgrade`, based on public `v0.3.1`.
- Runtime implementation commits: candidate history through `7d9221a`, plus
  the pending two-stage package lifecycle commit.
- Scope: Validate durable training jobs at admission and launch, permit queued
  admission while a trainer is active, reject duplicate targets, and report a
  successful launch as running rather than finished.
- Verification so far: Focused scheduler, runtime staging, retention, package
  return, and managed-runner tests pass. The real R20 training run remains on
  installed public v0.3.1 until training stops; its old runner cannot complete
  the newly specified two-stage validation lifecycle. The 0.3.2 candidate has
  not been installed or published.
- Production update: Pending real M2/M4 acceptance and explicit approval.

## 2026-08-06 - HawkSpan 0.3.1 upgrade repair

- Request: Publish the approved release-upgrade migration and rollback repair while preserving `v0.3.0`.
- Source branch: `fix/atomic-upgrade`, based directly on public `v0.3.0`.
- Implementation commit: `7862d3b`.
- Staging repository: `harryshawk/hawkspan-clean-staging`.
- Production repository and branch: `harryshawk/hawkspan`, `main`.
- Production tag: `v0.3.1`; existing tags and releases remain unchanged.
- Verification: The complete 27-test release gate passed. M4 upgraded from active revision `3338a32` through HawkSpan, removed both retired environment entries, reported ready on candidate `7862d3b`, and subsequently launched ChatGPT through HawkSpan `run_command`.
- Known issue: Long peer commands may be repeated after an outcome-unknown transport timeout; tracked publicly as issue #3 and not introduced by this repair.
- Production approval: Explicitly granted in the controlling Codex task on 2026-08-06.

## 2026-08-06 - HawkSpan 0.3.0 candidate

- Request: Document operation with or without the optional Codex Personal plugin and preserve the existing standalone runtime behavior.
- Source branch: `public-v0.3.0`, rooted directly at public `v0.2.0`.
- Staging repository: `harryshawk/hawkspan-clean-staging`.
- Production repository: `harryshawk/hawkspan`.
- Production branch and proposed tag: `main`, `v0.3.0`.
- Scope: Documentation, plugin version metadata, changelog, and this release-flow entry only; no runtime implementation changes.
- Production approval: Explicitly granted in the controlling Codex task after staging commit `d3c2e04429c791fe4cfef20c9eab4505f93ecf71` passed the complete 27-test release gate from a fresh clone of the staging repository.

## 2026-08-06 - HawkSpan 0.2.0 public release

- Request: Publish the completed HawkSpan-D candidate as a new public version while preserving the original public release.
- Development branch: `mac-link-hard-fork`
- Staging repository: `harryshawk/hawkspan-clean-staging`
- Staging branch: `hawkspan-v0.2.0-staging`
- Production repository: `harryshawk/hawkspan`
- Production branch and tag: `main`, `v0.2.0`
- Production approval: Explicitly granted in the controlling Codex task on 2026-08-06.
- Source-state policy: Staging and production receive the same sanitized snapshot commit whose parent is the preserved public `v0.1.0` commit.
- Verification: The complete local gate passed 27 tests; the queue/network review Word document was rendered and visually inspected.
- Legacy production: Existing `v0.1.0` tag, release, and commit remain unchanged.

## 2026-08-04 - HawkSpan D staging candidate

- Request: Preserve HawkSpan 0.1.0 and prepare the HawkSpan-D hard fork as the next public version.
- Branch: `mac-link-hard-fork`
- Verified implementation commit: `571231a0304391182b62ab063fe0f9157a075fc3`
- Staging repository: `harryshawk/hawkspan-clean-staging`
- Staging branch: `hawkspan-d-staging`
- Production repository: `harryshawk/hawkspan`
- Production update: Pending explicit approval.
- Public-history policy: Publish one sanitized snapshot commit on top of the legacy public commit; do not publish the private D development history.
- Legacy production: Commit `cb854b15238e27799f3cada73d47aaa407fad45b`, tag `v0.1.0`, and release `HawkSpan 0.1.0` remain unchanged.
- Verification: HawkSpan-D parity gate reported zero unexplained differences. M2 and M4 ran installed commit `571231a`; real peer job identity, start, complete process-tree stop, LoHa validation, packaging, reverse transfer, and M2 SHA-256 verification passed.
- Known staging limitation: The returned LoHa packet lacks evaluation sample renders. No public production update has been made.
