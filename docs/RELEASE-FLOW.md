# Private-to-public release flow

1. Keep the sealed predecessor evidence and shared baseline in private storage.
2. Develop sanitization only on the HawkSpan agent branch.
3. Regenerate `release/release-manifest.json` with
   `node scripts/check-release-tree.mjs --write`, then run syntax, regression,
   BDD, plugin, install/isolation, exact-tree, privacy, secret, license, and
   Git-history checks. Manifest regeneration is an explicit release-preparation
   action, never part of verification.
4. Review every privacy-scan exception manually.
5. Create a fresh release repository or orphan release branch from the
   sanitized tree. Do not push the private baseline ancestry.
6. Re-run the complete check suite against a fresh clone of that release
   history.
7. Stage privately for review.
8. Create the final public candidate as a fresh repository with neutral commit
   authorship. Do not carry staging pull-request refs, merge metadata, branches,
   tags, issues, or other staging surfaces into it.
9. Run the complete gate on that exact fresh-history candidate and its
   GitHub-generated archive. The worktree must pass both exact-tree and strict
   full-history checks. The archive has no `.git`, so it must pass exact-tree
   verification and must report that its history provenance was established
   before publication.
10. Push to the public repository only after explicit approval.

The public repository must contain no parent relationship to the unsanitized
baseline, even though the private working fork preserves that provenance.
Private staging is not itself a public artifact: account names and contributor
metadata introduced by staging review must not be promoted.

The manifest's `tree-sha256:` value is an exact content identifier, not a
signature or substitute for provenance. Git history and the trusted GitHub
publication surface establish origin; the manifest detects a different,
missing, or extra file after extraction and gives clone and archive installs a
common rollback identifier.
