# HawkSpan installation

## Human guide

On each trusted Mac, install Node.js, enable Remote Login, and create a
dedicated SSH key for the peer. Pin the peer host key in `known_hosts`; avoid
disabling host-key checking. The release verifier also requires `zsh`,
`python3`, `plutil`, and `rg` (ripgrep). Confirm Node supplies
`node:sqlite` with `node -e "require('node:sqlite')"`.

Clone `https://github.com/harryshawk/hawkspan.git` to a stable local
directory, or download the source archive from that repository's Releases
page. Then create `~/.hawkspan/config.json` from `config/example.json` and
`~/.hawkspan/hawkspan.env` from `config/hawkspan.env.example`.

Put the peer's Thunderbolt Bridge address, optional Ethernet fallback, node
identities, peer user, remote paths, and SSH-identity path in
`hawkspan.env`. Never commit the resulting files. HawkSpan parses the file
through a strict allowlist; never shell-source or evaluate it. Keep the
dedicated SSH private key itself in a separate mode-`600` file.
Keep `peer.allow_remote_wake` false unless the owner requests task wakeups and
provides the peer task identifier; both values are required for wakeups.
First run `scripts/check-release.sh`. It verifies both the exact public tree and,
when `.git` is present, the complete Git history. A GitHub source archive has no
Git metadata, so its gate verifies every extracted file against
`release/release-manifest.json` without pretending to recheck history.

Copy the exact `release_id` from that manifest into the owner-only file
`~/.hawkspan/installed-revision.json` as
`{ "schema_version": 1, "release_id": "tree-sha256:<64-hex-digest>" }`, then set
its mode to `600`. Do not invent or shorten the value. This is local rollback
evidence, not public configuration, and works for both Git clones and source
archives.

Run:

```sh
chmod 700 ~/.hawkspan
chmod 600 ~/.hawkspan/config.json
chmod 600 ~/.hawkspan/hawkspan.env
chmod 600 ~/.hawkspan/installed-revision.json
node scripts/test-mcp.mjs
node scripts/call-tool.mjs link_status
```

Repeat on the peer with the relationship reversed. Test messaging before
testing `peer_call_tool`, and test a harmless command before controlling an
application. Install the retry service with `scripts/install-link-agent.sh`
only after those foreground checks pass.

Start the foreground HTML control surface with
`node scripts/start-local-control.mjs`; it prints the loopback URL and remains
attached until stopped. Set `local_control.port` to choose a stable
nonzero loopback port before installing its persistent service, or set
`local_control.enabled` to `false` to disable it. HawkSpan
rejects non-loopback bind hosts.

Install optional reviewed application plugins only after the core checks pass.
See [the plugin lifecycle guide](docs/PLUGIN-LIFECYCLE.md). Keep HawkSpan
state, service labels, remote paths, and SSH identity isolated as described in
[the coexistence guide](docs/COEXISTENCE.md).

The bundled optional SimpleTuner workflow remains inert until its worker roots,
local trainer root, feature flags, and operations are explicitly configured.
Follow [the SimpleTuner workflow guide](docs/APPLICATION-WORKFLOWS-PLUGIN.md);
never point its tests or acceptance checks at a live trainer.
Prepare the optional Apple-silicon worker using
[the SimpleTuner setup guide](docs/SIMPLETUNER-SETUP.md).

For a reproducible demonstration, validate and review
`examples/simpletuner/hawkspan-robots/`, then copy either its standard LoRA or
ControlNet LoRA example into owner-only local workload state. Do not render
configuration, train, cache, or store outputs inside the repository. The
20-image set tests the end-to-end path; it is not represented as a
production-quality general model dataset.

If an installed plugin provides an application quick start, preview it before
confirming. Quick starts configure only reviewed role, capability, peer-tool,
and same-plugin operation restrictions; they never contain connection,
credential, path, token, local-control, local plugin configuration, or
application data. See [application plugins](docs/APPLICATION-PLUGINS.md).

## Agent guide

1. Inspect `link_status`; do not assume either route works.
2. Verify `node_id`, peer ID, ordered routes, and SSH transport readiness.
3. Send a non-waking message and confirm it reaches the peer.
4. Send an acknowledgement correlated to the original message ID.
5. Register and send a small test artifact; compare its SHA-256 on both ends.
6. Run a harmless peer command such as `uname -a`.
7. Install the background agent only after foreground checks pass.
8. Record operational authorization in a job when the task needs durable
   lifecycle evidence.

HawkSpan does not require or assume any inference, training, or media software.

## Recoverable removal

Preview core removal first:

```sh
scripts/uninstall-hawkspan.sh
```

The preview changes nothing. After the owner explicitly approves removal, run
`scripts/uninstall-hawkspan.sh --confirm`. The confirmed operation stops only
`org.hawkspan.link-agent` and `org.hawkspan.local-control`, then moves their
launch plists and the HawkSpan state directory into a timestamped directory
under `~/.hawkspan-uninstalled`. The archive includes `RESTORE.txt`; the
uninstaller does not permanently delete configuration or state.
