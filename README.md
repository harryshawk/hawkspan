# HawkSpan

HawkSpan is a macOS peer-agent link for two machines controlled by the same
owner. It supports two first-class modes:

1. durable agent-to-agent coordination; and
2. audited control of software on the peer through command and tool calls.

Messages, acknowledgements, jobs, wakeups, audit events, and SHA-256-verified
artifacts survive task restarts and temporary network outages. The first
configured route should normally be Thunderbolt Bridge; Ethernet is the
fallback. Inference offload is one possible workload, not the product boundary.

## Security model

HawkSpan currently assumes two trusted Macs, one owner, private networking,
SSH public-key authentication, and trusted local users. `run_command` is
intentionally broad: a compromised peer or local account can execute commands
with the HawkSpan user's privileges. See [SECURITY.md](SECURITY.md) before use.

Implemented safeguards include BatchMode SSH, configurable identity files,
primary/fallback routing, immutable message and artifact identities, SHA-256
verification, collision-safe artifact names, SQLite durability, and an
append-only application audit trail. Host-key pinning, command sandboxing,
mutual attestation, payload encryption beyond SSH, and multi-user authorization
policy are optional hardening—not claims about the current implementation.

Optional application plugins add validated, role- and origin-restricted
application operations without putting application-specific behavior in the
core. The HTML control surface is enabled by default on `127.0.0.1` only and
uses the same internal tool handlers as MCP. Its port and enabled state remain
user-configurable.

## Install

HawkSpan requires macOS, Node.js with `node:sqlite`, SSH connectivity between
the peers, and `rsync`. The release verifier also uses `zsh`, `python3`,
`plutil`, and `rg` (ripgrep). Verify the non-system prerequisites before
installing:

```sh
node -e "require('node:sqlite')"
python3 --version
rg --version
```

Installation is expected to be agent-assisted, typically by Codex or Claude
Code acting under the computer owner's instructions. The resulting
installation remains usable by a person through the localhost-only HTML
dashboard; manual interaction does not require an agent to remain attached.

1. Clone `https://github.com/harryshawk/hawkspan.git` to a stable path on each
   Mac, or download the source archive from that repository's Releases page,
   then run `scripts/check-release.sh`. A clone verifies both its exact files
   and Git history; an archive verifies its exact files.
2. Copy the exact `release_id` from `release/release-manifest.json` into the
   mode-`600` local rollback record described in [INSTALL.md](INSTALL.md).
3. Copy `config/example.json` to `~/.hawkspan/config.json` and
   `config/hawkspan.env.example` to `~/.hawkspan/hawkspan.env`.
4. Set node IDs, peer user, addresses, remote paths, and the dedicated SSH-key
   path in `hawkspan.env`. Keep the key itself in a separate mode-`600` file.
5. Restrict the config and state directory:

   ```sh
   chmod 700 ~/.hawkspan
   chmod 600 ~/.hawkspan/config.json
   chmod 600 ~/.hawkspan/hawkspan.env
   ```

6. Validate locally:

   ```sh
   node scripts/test-mcp.mjs
   node scripts/call-tool.mjs link_status
   ```

   Start the foreground dashboard and open the printed loopback URL:

   ```sh
   node scripts/start-local-control.mjs
   ```

7. Optionally install the two-minute retry agent:

   ```sh
   scripts/install-link-agent.sh
   ```

8. For a persistent human-facing dashboard, choose a nonzero
   `local_control.port` and install the local-control agent:

   ```sh
   scripts/install-local-control-agent.sh
   ```

The peer paths and addresses in the example are documentation-only values.

## Agent quick start

Call `link_status` first. Use `send_message` for durable instructions and
`acknowledge_message` for correlated acknowledgements. Use `create_job` when an
operation needs durable lifecycle state. Register a file before
`send_artifact`. Use `peer_call_tool` with `run_command` for peer software
control only when the user's active instruction authorizes that command.

## Development

```sh
node --check scripts/mcp-server.mjs
node scripts/test-mcp.mjs
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
```

Acceptance behavior is documented in `features/`. Provenance and release rules
are in `docs/`. See [application plugins](docs/APPLICATION-PLUGINS.md),
[the optional SimpleTuner workflow plugin](docs/APPLICATION-WORKFLOWS-PLUGIN.md),
[Apple-silicon SimpleTuner worker setup](docs/SIMPLETUNER-SETUP.md),
[the public robot LoRA and ControlNet acceptance examples](examples/simpletuner/hawkspan-robots/README.md),
[plugin authoring](docs/PLUGIN-AUTHOR-GUIDE.md),
[installation and lifecycle](docs/PLUGIN-LIFECYCLE.md),
[local HTML control](docs/LOCAL-CONTROL.md),
[privacy-safe real-pair acceptance](docs/REAL-PAIR-ACCEPTANCE.md),
[coexistence](docs/COEXISTENCE.md), and the
[high-trust threat model](docs/THREAT-MODEL.md).

## License

HawkSpan code is MIT License. Separately identified media and example
assets use the terms stated in [NOTICE](NOTICE), including the robot example
bundle's [CC BY 4.0 asset notice](examples/simpletuner/hawkspan-robots/ASSET-LICENSE.md).
