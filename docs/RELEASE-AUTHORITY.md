# Installed release authority

`~/.hawkspan/installed-revision.json` is the only authority for the active
HawkSpan release. It records the immutable active release root, exact Git
commit SHA, and the stable service root at
`~/.local/share/hawkspan/current`.

`activate-release.mjs` validates and publishes `hawkspan.env`, `config.json`,
and all five launchd plists before atomically committing the authority and
stable link. Those files may repeat derived paths but cannot select a release.
Activation accepts only a clean authorized Git checkout at that exact commit or
a package whose complete file set is bound to it by
`.hawkspan-release-provenance.json`. Package creation additionally verifies
that the exact commit already exists at the named staging or production branch;
an unpublished maintainer commit cannot become an activatable package.
Startup enables the LoRA scheduler only on a configured trainer and the packet
receiver only on a configured receiving node; the other three services are
core on both roles.

`hawkspan-startup.mjs` never repairs release paths. It rejects an executing
release, environment file, configuration file, or launchd service path that
disagrees with the authority before loading services. The core MCP service also
checks the authority when started directly.

Peer calls and readiness checks read the peer's installed-revision record over
SSH before selecting its `call-tool.mjs`. Static remote plugin and call-tool
paths are rejected.

Audit both machines with:

```sh
node ~/.local/share/hawkspan/current/scripts/audit-release-authority.mjs
```

The command exits nonzero and lists each live mismatch when the local or peer
installation is inconsistent.

## Multiple-maintainer source authority

`config/source-authority.json` names the canonical repository, staging
repository, production branch, release version, and required public ancestor.
The complete release gate fails on an unauthorized remote, dirty worktree,
version mismatch, or candidate that does not descend from that public commit.

Each release has one coordinator. All maintainers work on branches, publish
their commits before handoff, and converge through one pull request whose exact
commit passes the GitHub release gate. `main` is never force-pushed and release
tags are never moved. After review and explicit production approval, the
coordinator promotes that already-staged SHA by fast-forwarding `main`; GitHub's
squash, rebase, and merge-commit buttons are not release operations because
they create a different SHA. A history rewrite requires a separately recorded
owner instruction and recovery procedure; it is not an ordinary release
operation.
