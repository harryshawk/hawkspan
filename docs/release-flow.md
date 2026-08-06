# Release Flow

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
