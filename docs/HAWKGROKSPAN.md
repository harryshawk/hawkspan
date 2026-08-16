# HawkGrokSpan

HawkGrokSpan is a separately installed, separately configured HawkSpan endpoint
for durable messages and verified file exchange between the owner's M2 and one
trusted Grok VM. It uses the same reviewed HawkSpan source and release identity;
it is not a fork and it does not join the existing M2/M4 peer pair.

## Boundary

The `message-files` surface exposes exactly these MCP tools:

- link and durable message status;
- message send, retry, receive, list, and acknowledgement;
- artifact registration, verification, delivery, receive, and list;
- outbox retry for those messages and artifacts.

The server does not list or dispatch `run_command`, `peer_call_tool`, jobs,
queues, application plugins, presets, trainer operations, or LoRA automation.
Local browser control, application plugins, peer wake, peer commands, and
training controls must all remain disabled. Outgoing files must resolve inside
an explicit `transfer.allowed_artifact_roots` directory; a symlink cannot escape
that boundary.

This constrains the HawkGrokSpan link. It does not constrain Grok's independent
built-in local tools. Keep the bot in the VM trust boundary chosen by the owner.

## Separate identity

Use on both nodes:

- state: `~/.hawkgrokspan`, never `~/.hawkspan`;
- exchange directory: `~/HawkGrokSpan/Exchange`;
- one dedicated SSH key used only for this link;
- a forced-command `authorized_keys` entry for that key, running
  `scripts/hawkgrokspan-ssh-gateway.mjs` with forwarding, PTY, agent, X11, and
  user startup files disabled; the gateway accepts only receive-side rsync,
  exact receive-directory checks, artifact digesting, and a transport probe;
- one dedicated `known_hosts` file populated from an independently verified
  host key;
- remote inbox, artifact, and audit paths under the peer's
  `~/.hawkgrokspan` directory;
- a distinct MCP server name, `hawkgrokspan`.
- a distinct stable release link, normally
  `~/.local/share/hawkgrokspan/current`, selected during activation with
  `HAWKSPAN_STABLE_RELEASE_ROOT`;
- rendered launchd files kept under the isolated state directory unless a
  separately reviewed HawkGrokSpan background service is added.

Do not copy the live M2/M4 HawkSpan configuration, SQLite database, credentials,
task IDs, or service files. Do not enable remote wake: the first integration is
message and file exchange only.

## Why current Grok Build helps

The [official Grok coding agent](https://github.com/xai-org/grok-build) and its
[Grok shell documentation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)
support stdio MCP servers, project or user MCP configuration, headless prompts,
resumable session IDs, and ACP. Therefore the
VM can launch the same HawkSpan MCP server directly; no Grok-specific network
protocol is required. Start with MCP only. A later receiver may use a named
headless session or ACP, but that is a separate reviewed feature because Grok
headless mode has broad local tool access.

Browser-login credentials expire periodically. For unattended operation, the
VM owner must configure Grok's supported API-key, OIDC, or external-auth route
locally. HawkGrokSpan never transports or stores Grok or GitHub credentials.

## Grok VM handoff sequence

1. Verify the handoff manifest and every SHA-256 before extracting anything.
2. Confirm the release Git commit and complete HawkSpan gate recorded by the
   handoff match the extracted files.
3. Install a Node runtime capable of running this release, OpenSSH client and
   server, and `rsync`. Linux may provide `sha256sum` instead of macOS
   `shasum`; HawkSpan accepts either for remote verification.
4. Create `~/.hawkgrokspan` and `~/HawkGrokSpan/Exchange` with owner-only
   permissions.
5. Create a dedicated SSH key, exchange only public keys, independently verify
   each host key, and install each public key only with the documented
   forced-command gateway restrictions. A plain login-capable key is a failed
   installation.
6. Customize `config/hawkgrokspan-grok-vm.example.json`; do not enable any
   disabled feature or broaden the artifact root.
7. Activate with `HAWKSPAN_STATE_DIR=~/.hawkgrokspan`,
   `HAWKSPAN_STABLE_RELEASE_ROOT=~/.local/share/hawkgrokspan/current`, and an
   isolated `HAWKSPAN_LAUNCH_AGENTS_DIR`; do not overwrite normal HawkSpan
   service definitions.
8. Merge `config/hawkgrokspan-grok.config.toml.example` into the trusted
   user-level `~/.grok/config.toml` using absolute paths.
9. Start Grok and confirm it lists only the thirteen `hawkgrokspan__*` tools.
10. Run acceptance in this order: link status, M2-to-VM message, VM
   acknowledgement, VM-to-M2 message, one harmless text file each direction,
   exact SHA-256 comparison, and one outside-root transfer rejection.

Do not configure automation or unattended polling until this manual acceptance
passes and the owner separately approves a receiver design.

## Acceptance evidence

The source release includes two executable tests beyond static review:

- `test-hawkgrokspan-boundary.mjs` starts the real MCP server, proves the exact
  thirteen-tool surface, directly attempts forbidden shell and peer calls,
  checks normal and symlink file escapes, inspects strict SSH arguments, and
  proves malformed configurations fail startup.
- `test-hawkgrokspan-exchange.mjs` starts two isolated real MCP servers, moves
  immutable envelopes across the simulated transport, verifies correlated
  acknowledgement state, transfers an artifact, performs remote SHA-256, and
  imports the verified file on the receiving side.

Those tests supplement, not replace, manual source review and the complete
release gate. Real-node acceptance must still use the actual M2 and VM network,
SSH host keys, filesystems, Grok MCP discovery, and acknowledgement records.
