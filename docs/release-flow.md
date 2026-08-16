# Release Flow

## 2026-08-15 - HawkSpan 0.3.7 authorization and lineage repair

- Release intent: publish the recovered 0.3.6 implementation on the canonical
  MIT history and require recorded owner authorization for trainer lifecycle
  operations without adding another owner prompt.
- Recovery evidence: installed authority named unpublished commit `c3bc982`;
  its 33 post-0.3.5 commits were replayed onto public MIT `main` at `9bad60b`
  before applying the reviewed authorization repair.
- Multiple-maintainer invariant: one release coordinator, branch-and-PR
  convergence, exact-SHA fast-forward promotion after approval, immutable
  `main` and tags, a required public ancestor in source authority, and
  exact-commit/content-hashed release activation.
- Staging repository and branch: `harryshawk/hawkspan-clean-staging`,
  `hawkspan-v0.3.7-staging`.
- Production repository and proposed tag: `harryshawk/hawkspan`, `v0.3.7`.
- Production update: pending the complete gate from the exact staging commit
  and explicit owner approval.

## 2026-08-07 - Owner-authorized license correction

- Request: Apply the owner-specified MIT License to every public HawkSpan
  version from its original publication point and remove the unauthorized
  alternative license notices.
- Scope: Rewrite every public branch and release tag while preserving each
  version's product files apart from the license correction; retain the
  separately stated media terms.
- Verification: Every rewritten public ref contains the normalized SPDX MIT
  text with Harry Hawk as copyright holder, the superseded notices are absent,
  and the complete release gate passes before publication.

## 2026-08-07 - HawkSpan 0.3.5 validation-input staging repair

- Release intent: ensure every immutable runtime job contains the fixed
  validation and ControlNet files its packet contract names.
- Acceptance evidence: the staging regression requires copied control and
  source-target inputs, readiness binds their hashes, and package retry accepts
  only a package-return failure at the exact supplied revision fingerprint.
- Promotion condition: the complete release gate passes before the exact commit
  is installed on M2 or M4.

## 2026-08-06 - HawkSpan 0.3.4 skipped-current repair

- Request: Exercise real queue controls before four uninterrupted 100-step
  completion runs.
- Defect evidence: Skipping stopped R24 changed its item state to `skipped`
  but left `current` reporting R24 because the control compared only the queue
  item ID while the scheduler stores the target name after launch.
- Scope: Clear `current` for either representation and cover the target-name
  representation in the queue-control regression test.

## 2026-08-06 - HawkSpan 0.3.3 scheduler serialization repair

- Request: Queue multiple real 100-step LoRA plus ControlNet runs and exercise
  lifecycle controls on the public release.
- Source branch: `fix/atomic-upgrade`, based on public `v0.3.2`.
- Scope: Hold one process-wide scheduler lock from candidate selection through
  trainer launch and durable-state update.
- Defect evidence: Two overlapping launchd invocations selected R23 and R24;
  R24 started and R23 correctly refused its readiness gate because training
  had become active.
- Verification: The cross-process regression starts two scheduler processes
  simultaneously and requires exactly one trainer adapter invocation; the
  complete release gate is required before publication.

## 2026-08-06 - HawkSpan 0.3.2 queue-admission candidate

- Request: Exercise multiple real 100-step LoRA plus ControlNet jobs and queue
  controls through HawkSpan.
- Source branch: `fix/atomic-upgrade`, based on public `v0.3.1`.
- Runtime implementation commits: candidate history through `7d9221a` and
  two-stage package lifecycle commit `a7cdf05`.
- Staging repository and branch: `harryshawk/hawkspan-clean-staging`,
  `hawkspan-v0.3.2-staging`.
- Scope: Validate durable training jobs at admission and launch, permit queued
  admission while a trainer is active, reject duplicate targets, and report a
  successful launch as running rather than finished.
- Verification so far: Focused scheduler, runtime staging, retention, package
  return, and managed-runner tests pass. The real R20 training run remains on
  installed public v0.3.1 until training stops; its old runner cannot complete
  the newly specified two-stage validation lifecycle. The 0.3.2 candidate has
  not yet been installed.
- Production update: Explicitly approved in the controlling Codex task after
  the complete 28-test source gate and independent lifecycle review passed.

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
