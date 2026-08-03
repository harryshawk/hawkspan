# HawkSpan agent installation guide

This file is the entry point for Codex, Claude Code, and other terminal-capable
agents installing HawkSpan. Follow the owner's active instructions first, then
this guide, `INSTALL.md`, and the documents linked below.

## Product boundary

HawkSpan connects two Macs owned and trusted by the same person, typically in
the same room. It is not a multi-user or hostile-network security boundary.
The HTML control surface must bind only to loopback.

Treat each existing peer-link product as independent. In particular, do not
inspect, import, modify, stop, uninstall, or reuse Mac Link configuration,
state, services, credentials, messages, artifacts, or task identifiers. Follow
`docs/COEXISTENCE.md`. Coexistence is the default; replacement or cutover
requires explicit owner authorization.

## Never commit local installation data

Keep behavioral configuration under `~/.hawkspan/config.json` and all
machine-specific values under `~/.hawkspan/hawkspan.env`, never in this
repository. Create the environment file from `config/hawkspan.env.example`,
set mode `600` (or `400` when no edits are needed), and let HawkSpan's strict allowlisted parser read it once at
startup. Never shell-source or evaluate it. Do not commit or report private
usernames, hostnames, addresses, SSH material, absolute personal paths, task
identifiers, message contents, or application workload data. Use only the
documentation placeholders from the two example files. Dedicated SSH private
keys remain separate mode-`600` files; the environment file stores only paths.

## Owner checkpoints

Stop and request the owner's direct participation only when macOS or GitHub
requires it, including:

- enabling Remote Login or approving a system permission;
- approving an SSH key or first connection when identity cannot be verified;
- choosing which physical/network route corresponds to each Mac;
- supplying a peer task identifier when wakeups are requested;
- authorizing application control, consequential commands, cutover, removal,
  publication, or deletion.

If an optional checkpoint is unavailable, skip that optional feature, record
it, and continue with safe independent checks. Never guess a credential,
identity, address, role, or destructive authorization.

## Installation sequence

Perform these steps on both Macs, reversing local and peer values on the
second Mac.

1. Confirm macOS, Node.js with `node:sqlite`, `ssh`, and `rsync` are available.
2. Keep the repository at a stable path that will not be moved after service
   installation.
3. Run `scripts/check-release.sh` from the repository. Stop on any failure.
4. Confirm SSH connectivity and pin the peer host key. Keep strict host-key checking
   enabled. Use a HawkSpan-specific SSH identity.
5. Create `~/.hawkspan` with mode `700`. Copy `config/example.json` to
   `~/.hawkspan/config.json` and `config/hawkspan.env.example` to
   `~/.hawkspan/hawkspan.env`; set both to mode `600`.
   Copy the exact `release_id` from `release/release-manifest.json` into
   `~/.hawkspan/installed-revision.json` as `schema_version: 1` and
   `release_id: tree-sha256:<64-hex-digest>`, then set mode `600`. Do not invent
   or shorten it. This identifier works identically in Git clones and GitHub
   source archives.
6. Put unique node IDs, peer user, enabled routes, route labels, peer
   addresses, dedicated SSH-identity path, HawkSpan-only remote paths, and the
   fixed local port in `hawkspan.env`. Keep the dedicated SSH private key in a
   separate mode-`600` file; never put key contents in the environment file.
7. Select `symmetric` unless the owner requests asymmetric controller/worker
   roles. Set only the minimum inbound and outbound capabilities required.
   Wakeups additionally require the owner's peer task identifier and
   `peer.allow_remote_wake` set to `true`; otherwise keep it `false` and rely
   on the durable inbox.
8. Keep `local_control.enabled` on unless the owner disables it. Bind it to
   `127.0.0.1`; choose a nonzero stable port for a persistent service.
9. Run foreground validation before installing background services:
   `node scripts/test-mcp.mjs`, then
   `node scripts/call-tool.mjs link_status`. Start
   `node scripts/start-local-control.mjs`, open its printed loopback URL, and
   stop it only after the dashboard responds.
10. Validate each enabled route independently. A disabled route is acceptable;
    a configured but unreachable route must be reported.
11. Send a non-waking test message, acknowledge the exact message ID, transfer
    a small registered artifact, and verify its SHA-256 on both Macs.
12. Run only an owner-authorized harmless peer command. Do not test arbitrary
    application control without explicit authorization.
13. Install the retry service with `scripts/install-link-agent.sh` only after
    foreground peer validation passes.
14. Install the persistent HTML service with
    `scripts/install-local-control-agent.sh` only after its port is configured
    and the foreground control surface succeeds.
15. Re-run `link_status`, MCP status, route status, and the message/artifact
    checks through the installed services.

## Application plugins

HawkSpan is one public product. Its bundled examples and optional published
plugins must also be sanitized for public release; only installation values,
credentials, state, datasets, models, and generated outputs stay local. Inspect
every plugin and its manifest before installation, then follow
`docs/PLUGIN-LIFECYCLE.md`. Install
with `node scripts/install-application-plugin.mjs /path/to/reviewed-plugin`.
Respect plugin role, origin, operation, and feature restrictions. Never weaken
core authorization merely because a plugin requests an operation.

If a reviewed plugin exposes application quick-start presets, list and preview
the selected preset before applying it. Obtain confirmation for apply or
reset. Verify that the preview contains only role, approved capabilities,
same-plugin peer tools, and same-plugin enabled operations. Presets must never
carry or change connections, credentials, paths, tokens, local-control
settings, plugin configuration, other plugin entries, or application data.
Restart HawkSpan and repeat the harmless plugin check afterward.

### Bundled SimpleTuner robot examples

The public acceptance/demo bundle at
`examples/simpletuner/hawkspan-robots/` contains the 20-image conventional SDXL
LoRA used for release and Draw Things acceptance, plus a separate 20-pair Canny
ControlNet PEFT LoHa trainer example. The ControlNet example is not proof that a
conventional LoRA can be imported into Draw Things. Before use, run
`node scripts/test-simpletuner-example-bundle.mjs`, read its `README.md` and
`ASSET-LICENSE.md`, then copy the selected example into owner-only local
workload state. Never train in the repository or write rendered configs,
caches, checkpoints, models, receipts, or outputs back into the public tree.
Use the `application-workflows` adapter and the explicit authorization flow in
`docs/APPLICATION-WORKFLOWS-PLUGIN.md`; do not substitute broad commands.
Prepare the worker first with `docs/SIMPLETUNER-SETUP.md`.
These 20 images demonstrate and test the pipeline but are not a
production-quality general training set.

## Upgrade, rollback, and removal

Before an upgrade, record the installed release ID, service status, configuration
schema version, and plugin inventory. Preserve the existing installation and
state until the upgraded peer pair passes foreground and service validation.
If validation fails, stop HawkSpan's own services and restore only the prior
HawkSpan installation; do not touch another product.

Preview core removal with `scripts/uninstall-hawkspan.sh`. The preview is
read-only. After obtaining explicit owner approval, run
`scripts/uninstall-hawkspan.sh --confirm`. It stops only HawkSpan's two core
launch services and moves HawkSpan-owned launch plists, configuration, and
state into a timestamped archive under `~/.hawkspan-uninstalled`. It does not
delete the archive. Follow its `RESTORE.txt` to recover the installation.
Plugin removal alone follows `docs/PLUGIN-LIFECYCLE.md` and is recoverable.

## Required completion report

Report, without private values:

- installed HawkSpan release ID and repository location category;
- each Mac's logical node role;
- which named routes are enabled and whether each passed;
- SSH transport and pinned-host verification result;
- foreground and background service results;
- messaging, acknowledgement, artifact-integrity, MCP, and HTML results;
- installed plugin IDs and test results;
- skipped owner checkpoints, remaining limitations, and rollback posture.

Do not call installation complete while any required check is failing.

## Authoritative references

- `INSTALL.md` — human and agent installation overview
- `docs/CONNECTIONS.md` — one-route and two-route configuration
- `docs/MACHINE-SETTINGS.md` — strict private environment-file boundary
- `docs/CONFIGURATION-FLAGS.md` — profiles, roles, and capabilities
- `docs/LOCAL-CONTROL.md` — loopback HTML service
- `docs/SIMPLETUNER-SETUP.md` — Apple-silicon SimpleTuner worker setup
- `docs/APPLICATION-PLUGINS.md` — plugin model and restrictions
- `examples/simpletuner/hawkspan-robots/README.md` — public LoRA and ControlNet demo bundle
- `docs/PLUGIN-LIFECYCLE.md` — reviewed plugin installation and removal
- `docs/COEXISTENCE.md` — isolation from Mac Link and other tools
- `docs/REAL-PAIR-ACCEPTANCE.md` — explicitly authorized real-machine checks
- `docs/THREAT-MODEL.md` — intended high-trust environment
