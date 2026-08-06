# Installed release authority

`~/.hawkspan/installed-revision.json` is the only authority for the active
HawkSpan release. It records the immutable active release root, release ID, and
the stable service root at `~/.local/share/hawkspan/current`.

`activate-release.mjs` validates and publishes `hawkspan.env`, `config.json`,
and all five launchd plists before atomically committing the authority and
stable link. Those files may repeat derived paths but cannot select a release.
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
