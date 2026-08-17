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
Local browser control, application plugins, remote peer wake, peer commands, and
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
- HGS ignores user and machine-wide OpenSSH client configuration and supplies
  its identity, pinned host file, proxy, timeouts, and keepalive settings
  explicitly; an unrelated broken `/etc/ssh/ssh_config.d` include must not
  take the message/file link down;
- remote inbox, artifact, and audit paths under the peer's
  `~/.hawkgrokspan` directory;
- a distinct MCP server name, `hawkgrokspan`.
- a distinct stable release link, normally
  `~/.local/share/hawkgrokspan/current`, selected during activation with
  `HAWKSPAN_STABLE_RELEASE_ROOT`;
- on macOS, the separate `org.hawkgrokspan.message-receiver` launchd service;
  never reuse an `org.hawkspan.*` service definition.

Do not copy the live M2/M4 HawkSpan configuration, SQLite database, credentials,
task IDs, or service files. Do not enable remote wake. HawkGrokSpan notification
is instead requested locally by the forced receive-only gateway after a durable
inbox delivery; it never gives the sender a remote process-control command.

## Multiple bot routing and local notification

An ordinary message may include `target_bot_id`. The receiving node maps that
stable route name to one exact, already-persisted Codex or Grok session UUID in
its own `message_receiver.targets` configuration. Untargeted older envelopes go
only to `message_receiver.default_target`; unknown targets never fall through to
another bot. This supports several bots on either endpoint without running a
second HawkGrokSpan installation or sharing one bot's lease with another.
An unknown target is terminally marked `routing_failed` and produces a
correlated failure message to the sender; it is never silently rerouted.

Each configured target has its own owner-controlled working directory, exact
CLI executable, matching sandbox, maximum runtime, and fenced process lease.
One slow bot therefore cannot block another bot. The receiver coalesces messages
that arrive while a target is active, checks again before ending, and treats the
durable message acknowledgement as completion. Starting a CLI process is not
acceptance. Acknowledgement envelopes never launch a receiver. Ordinary HGS
messages always notify their configured target; callers cannot accidentally
leave an unread ordinary message by selecting a quiet-send option. After import,
the durable database row is authoritative for route and notification intent;
replacing the JSON file cannot change either.

A single local reconciliation supervisor starts when an inbox delivery arrives,
when the HGS MCP server starts, or through the managed macOS launchd service. It
imports acknowledgements without launching a bot and retries ordinary
unacknowledged messages with bounded increasing backoff after adapter failure,
authentication failure, a busy owner goal, or timeout. Its lease records the
exact release revision, script path, session, process nonce, and maximum
runtime. A reused or unrelated PID is never signalled and cannot wedge the
lease. The old supervisor checks release authority every second and retires when
activation changes revisions; launchd restarts the exact stable-link revision.
This supervisor is local notification plumbing, not remotely invocable command
control.

On macOS, run `scripts/install-hawkgrokspan-message-receiver.sh` after activation
and verify the release audit before acceptance. The Grok Docker VM has no systemd
PID 1. Its Extra Awake feature is a prompt-only agent poll, not a fixed command
hook; it must not be documented as a service manager. Inbox delivery invokes the
installed receiver `--ensure-supervisor` entrypoint once the private transport is
running. Extra Awake is not installation, recovery, or acceptance plumbing.
Recovery is an owner-invoked, idempotent bootstrap followed by a real Grok
Computer Update check that covers SSH, userspace Tailscale, the TCP forwarder,
the receiver, and the exact Grok CLI session. File persistence alone is not
acceptance.

The receiver prompt is goal-aware: it must inspect current goal state, may
continue a matching receiver goal, must not overwrite an unrelated owner goal,
and must not let a completed, blocked, or stale bootstrap goal suppress message
delivery. The receiver is one bounded continuation and must not leave a
synthetic receiver-only goal active.

## Private overlay transport

When neither node can route to the other's private address, use a private
Tailscale tailnet rather than exposing SSH through a public router. The M2 uses
the native Tailscale network interface. A capability-constrained Docker VM may
run `tailscaled` in userspace-networking mode, publish only its local SSH server
to the tailnet with a private TCP forwarder, and configure
`peer.transport.kind` as `tailscale-nc` so outbound OpenSSH and rsync streams go
through the exact root- or owner-controlled Tailscale executable recorded in
`peer.transport.command`. When the VM runs a user-scoped daemon without
systemd, `peer.transport.socket` records its normalized absolute socket path
under the persistent HawkGrokSpan directory; the SSH proxy passes that path to
the Tailscale client explicitly.

The server rejects other proxy kinds, relative or metacharacter-bearing paths,
symlinks, non-executable files, executables owned by unrelated users, and
group- or other-writable proxy executables. Strict host-key checking, the
dedicated SSH identity, forced-command receiver gateway, empty peer-tool lists,
disabled commands, and exchange-root restriction remain mandatory. Tailnet
policy must deny by default and permit only TCP port 22 between the two dedicated
HawkGrokSpan nodes. Tailscale Funnel and public SSH exposure are not part of this
design.

### M2 Tailscale setup

Install the official macOS Tailscale package, approve its system extension and
VPN configuration, enable start-at-login, and sign the Mac into the owner's
tailnet. Give the node a stable HGS-specific hostname such as
`hawkgrokspan-m2`. Record its MagicDNS name and Tailscale IP as deployment
evidence. If an App Store copy was previously installed, remove the duplicate
and reboot before acceptance; two macOS Tailscale installations conflict.

Do not enable an exit node, subnet routes, Funnel, or Tailscale SSH. Replace the
tailnet's initial allow-all policy with a deny-by-default grant that permits only
TCP 22 from the M2 HGS node to the Grok VM HGS node and back. Replace the two
addresses below with the recorded HGS node addresses, preview the policy, and
save only when the preview contains exactly these two grants:

```json
{
  "grants": [
    { "src": ["M2_TAILSCALE_IP"], "dst": ["GROK_VM_TAILSCALE_IP"], "ip": ["tcp:22"] },
    { "src": ["GROK_VM_TAILSCALE_IP"], "dst": ["M2_TAILSCALE_IP"], "ip": ["tcp:22"] }
  ]
}
```

A green Tailscale UI is not sufficient evidence. Acceptance must prove native
SSH from M2 to the VM and the VM's configured `tailscale-nc` path back to M2,
including one real transfer in each direction.

### Persistent Grok VM Tailscale setup

For a Grok Docker computer without systemd or network capabilities, install the
official stable Debian package and run a user-scoped daemon in userspace mode:

```sh
mkdir -p "$HOME/HawkGrokSpan/TailscaleState"
chmod 700 "$HOME/HawkGrokSpan" "$HOME/HawkGrokSpan/TailscaleState"
nohup tailscaled \
  --tun=userspace-networking \
  --state="$HOME/HawkGrokSpan/TailscaleState/tailscaled.state" \
  --socket="$HOME/HawkGrokSpan/TailscaleState/tailscaled.sock" \
  --socks5-server=127.0.0.1:1055 \
  >"$HOME/HawkGrokSpan/TailscaleState/tailscaled.log" 2>&1 &
tailscale --socket="$HOME/HawkGrokSpan/TailscaleState/tailscaled.sock" up \
  --hostname=hawkgrokspan-grok-vm --accept-dns=false
```

The owner must open the resulting one-time login URL. After the tailnet policy
is in place, expose only the VM's existing OpenSSH receiver to the private
tailnet:

```sh
tailscale --socket="$HOME/HawkGrokSpan/TailscaleState/tailscaled.sock" \
  serve --bg --tcp=22 tcp://127.0.0.1:22
```

The Grok workspace sandbox may report a root-owned `/usr/bin/tailscale` as an
unrelated owner. Copy that already-reviewed binary to the owner-only workspace,
verify both SHA-256 values match, and point only `peer.transport.command` at the
owned regular executable:

```sh
mkdir -p "$HOME/HawkGrokSpan/bin"
chmod 700 "$HOME/HawkGrokSpan/bin"
cp /usr/bin/tailscale "$HOME/HawkGrokSpan/bin/tailscale"
chmod 755 "$HOME/HawkGrokSpan/bin/tailscale"
sha256sum /usr/bin/tailscale "$HOME/HawkGrokSpan/bin/tailscale"
```

Keep `peer.transport.socket` set to the persistent userspace socket. After a
Grok Computer Update, packages, host keys, IPs, and processes may change even
when home-directory files persist. The reviewed recovery sequence is: restore
OpenSSH and `rsync` if missing, start `sshd`, start the userspace daemon, reapply
the private TCP forwarder, verify the new SSH host key with the owner, refresh
the owner-controlled Tailscale copy and digest if the package changed, then
restart HGS and verify its exact release and session. Keep the recovery command
owner-invoked unless the hosting product provides a reviewed persistent service
facility. Extra Awake must remain disabled during message-wake acceptance and
is never part of normal delivery or recovery.

### Dedicated SSH key installation

On each receiving node, install only the peer's public key in
`~/.ssh/authorized_keys` with one forced-command entry. Replace the absolute
release, state, and public-key placeholders; do not use a shell alias or a
relative path:

```text
restrict,command="/usr/bin/env node /ABSOLUTE/HGS/CURRENT/scripts/hawkgrokspan-ssh-gateway.mjs --state-root /ABSOLUTE/HOME/.hawkgrokspan" ssh-ed25519 PEER_PUBLIC_KEY HGS_PEER_LABEL
```

`restrict` disables forwarding, PTY, agent, X11, and user startup behavior.
The gateway then permits only the receive-side HGS protocol. Acceptance must
prove the HGS transport probe succeeds and an arbitrary command such as
`uname -a` is rejected by the gateway.

Populate the dedicated HGS `known_hosts` file only after independently
verifying the peer's Ed25519 host-key fingerprint. Its host token must exactly
match `peer.primary_host`: record the MagicDNS name when configuration uses the
name, or the 100.x address when configuration uses the address. A Grok Computer
Update may replace the VM host key. If it does, stop delivery, independently
verify the new fingerprint, replace only the stale VM entry on M2, and repeat
the strict-host-key transport probe. Never weaken `StrictHostKeyChecking=yes`.

## Why current Grok Build helps

The [official Grok coding agent](https://github.com/xai-org/grok-build) and its
[Grok shell documentation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)
support stdio MCP servers, project or user MCP configuration, headless prompts,
exact resumable session IDs, bounded turns, tool allowlists, and ACP. Therefore the
VM can launch the same HawkSpan MCP server directly; no Grok-specific network
protocol is required. The reviewed receiver resumes only an exact persisted
session UUID and supplies an explicit HawkGrokSpan-only tool allowlist. Friendly
session-name creation or discovery is not an accepted substitute.

Install the official Linux CLI from `https://x.ai/cli/install.sh`. The current
installer places a convenience symlink at `~/.grok/bin/grok`; resolve it and
configure the owner-controlled regular executable under `~/.grok/downloads`,
not the symlink. A Grok Bot application agent UUID is not a Grok
CLI session UUID. Authenticate a headless VM with `grok login --device-auth`,
create a dedicated persisted CLI session, and prove `--resume` against that exact
session before adding it to `message_receiver.targets`. Browser-login
credentials expire periodically. HawkGrokSpan never transports or stores Grok
or GitHub credentials.

## Grok VM handoff sequence

1. Verify the handoff manifest and every SHA-256 before extracting anything.
2. Confirm the release Git commit and complete HawkSpan gate recorded by the
   handoff match the extracted files.
3. Install a Node runtime capable of running this release, OpenSSH client and
   server, `rsync`, and the reviewed Tailscale client when the private overlay
   is required. Linux may provide `sha256sum` instead of macOS `shasum`;
   HawkSpan accepts either for remote verification.
4. Create `~/.hawkgrokspan` and `~/HawkGrokSpan/Exchange` with owner-only
   permissions.
5. Create a dedicated SSH key, exchange only public keys, independently verify
   each host key, and install each key only with the forced-command gateway
   entry above. A plain login-capable key is a failed installation.
6. Stage the same committed HGS revision and tree on M2 and the VM. Activate it
   on both nodes under the separate HGS state and stable-link paths. Run the
   local release audit on each node. Do not begin acceptance until both installed
   receipts, stable links, and live receiver processes report that exact revision.
7. Customize `config/hawkgrokspan-grok-vm.example.json`; create every dedicated
   receiver working directory and do not enable any disabled feature or broaden
   the artifact root. Point `config/hawkgrokspan-grok.config.toml.example` at the
   stable release path and an exact persistent Node executable, never an
   extracted handoff, old package path, or PATH-dependent `/usr/bin/env node`.
   Merge it into the Grok configuration actually loaded by the dedicated
   receiver workspace. Create
   `.grok/sandbox.toml` in the dedicated workspace with
   the following profile so the sandboxed Grok session can write only HGS state:

   ```toml
   [profiles.hawkgrokspan]
   extends = "workspace"
   read_write = ["/home/GROK_VM_USER/.hawkgrokspan"]
   ```

   Set each Grok receiver target's `sandbox` to `hawkgrokspan`. The built-in
   `workspace` profile cannot open the HGS SQLite state outside the workspace,
   while `off` grants substantially broader machine access and is not accepted.
   Because no person is present to answer a headless tool prompt, the installed
   receiver passes exact per-tool allow rules for the same thirteen HGS
   message/file tools. It does not enable Grok's broad always-approve mode.
   Without these narrow rules, Grok cancels the first `receive_messages` call
   and a delivered message remains unread.
8. Install the official Grok CLI and authenticate with the documented headless
   device-code flow. Only after the stable MCP path, sandbox profile, state
   directory, and owned Tailscale command are correct, create the dedicated
   persisted Grok session
   under `--sandbox hawkgrokspan`. Confirm that exact session lists all thirteen
   HGS tools, then write its UUID into the receiver target. Grok binds a session
   to its creation profile and may retain MCP startup failure state; a session
   created under `workspace`, `off`, or before the MCP prerequisites were fixed
   is not an accepted receiver session.
   Record its exact real executable, version, digest, and resumable UUID. Recheck
   all four after a Grok CLI update.
9. Start the exact installed HGS receiver on both nodes. On macOS, install the
   dedicated HGS launchd service. On the VM, keep an owner-invoked, idempotent
   recovery command that restores or verifies OpenSSH, `rsync`, `sshd`, the
   userspace Tailscale socket, private TCP-22 Serve mapping, owned Tailscale
   client copy, host-key pins, exact HGS revision, and exact Grok session before
   starting the receiver. It must log each bounded step and stop nonzero on the
   first failure so partial recovery cannot masquerade as ready.
10. Perform a real Grok Computer Update and run that recovery sequence. Prove
    any new VM host key was explicitly re-verified and re-pinned, then repeat
    bidirectional transport and message acceptance with Extra Awake off.
11. Run acceptance in this order: compare exact source/tree/receipt/live-receiver
    revision on both nodes; link status; M2-to-VM targeted message and
    durable acknowledgement, VM-to-M2 targeted message and acknowledgement, a
    second target on each configured multi-bot side, one deliberately slow
    target while another completes, acknowledgement/no-notification non-wake,
    one harmless text file each direction, exact SHA-256 comparison, and one
    outside-root transfer rejection, plus an arbitrary SSH-command rejection.

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
- `test-hawkgrokspan-message-receiver.mjs` launches isolated Codex and Grok
  adapter processes, proves exact target routing and argv boundaries, independent
  per-bot leases, active-run coalescing, acknowledgement/no-notification silence,
  default-target compatibility, immutable route/notification enforcement,
  PID-reuse recovery, managed-service lifecycle, sender-visible unknown-target
  failure, bounded retry backoff, and the real forced-gateway-to-local-receiver
  trigger.

Those tests supplement, not replace, manual source review and the complete
release gate. Real-node acceptance must still use the actual M2 and VM network,
SSH host keys, filesystems, Grok MCP discovery, and acknowledgement records.
