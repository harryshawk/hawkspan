# Add a second Codex-to-Grok HGS peer

This adds a direct HGS connection from another Mac to the same Grok VM. It uses
the same HGS commit as the existing pair, not a modified copy. Normal HawkSpan
is unchanged.

## Keep the pair independent

Choose a label such as `m4` and use it consistently:

| Resource | Second Mac | Grok VM sibling |
| --- | --- | --- |
| State | `~/.hawkgrokspan-m4` | `~/.hawkgrokspan-m4` |
| Exchange | `~/HawkGrokSpan-M4/Exchange` | `~/HawkGrokSpan-M4/Exchange` |
| Stable release | `~/.local/share/hawkgrokspan-m4/current` | `~/.local/share/hawkgrokspan-m4/current` |
| Local target | `m4-primary` | `grok-m4-primary` |
| Codex MCP name | `hawkgrokspan-m4` | `hawkgrokspan` inside its isolated Grok workdir |

Give the pair its own SSH key, `known_hosts`, Grok Build session UUID, receiver
workdir, audit directory, and TCP-22 tailnet grants. Do not copy either pair's
database, private key, session UUID, inbox, or outbox.

## Configure transport

Install Tailscale on the second Mac and join the same tailnet. Add only the two
TCP-22 grants between that Mac and the Grok VM. Do not enable Funnel, exit-node
routing, subnet routes, or the separate Tailscale SSH product.

Generate a dedicated Ed25519 client key on each sending endpoint. Put its
public half in the receiving account's `authorized_keys` using the HGS forced
gateway command from `HAWKGROKSPAN.md`. Record each peer's current Ed25519 host
key in this pair's dedicated `known_hosts`. Use the actual second-Mac account
and home path; do not copy those values from the first Mac.

Prove native OpenSSH from the Mac to the VM and the configured `tailscale nc`
proxy from the VM to the Mac. A successful link is enough; do not repeat setup
or replace working identities.

## Configure and start HGS

Copy the supplied M2 and Grok VM configuration examples into the two new state
roots and replace paths, node IDs, peer details, and targets. Keep
`surface_profile=message-files`, peer command lists empty, local control off,
the queue supervisor off, remote wake off, and peer commands off.

Create one new persisted Grok Build session in the sibling workdir. Verify that
the resumed session sees the thirteen HGS message/file tools, then store that
exact session UUID under `grok-m4-primary`.

Package the same reviewed commit on both endpoints. Activate each package with
the new state, config, and stable-root environment values. Start one receiver
for each state root. On a VM without systemd, start the sibling explicitly:

```sh
nohup env \
  HAWKSPAN_STATE_DIR="$HOME/.hawkgrokspan-m4" \
  HAWKSPAN_CONFIG="$HOME/.hawkgrokspan-m4/config.json" \
  /ABSOLUTE/PERSISTENT/NODE \
    "$HOME/.local/share/hawkgrokspan-m4/current/scripts/hawkgrokspan-message-receiver.mjs" \
    --service \
  >>"$HOME/.hawkgrokspan-m4/audit/message-receiver-service.log" 2>&1 &
```

## Use and accept it

Send one ordinary message and one harmless file each way. Confirm both durable
acknowledgements and both SHA-256 values. Then send one bounded coding task and
one bounded research task; review the returned file/report before acknowledging
them. Extra Awake and owner relay are not part of normal operation.

After a Mac power cycle, first check the route, installed receipt, stable link,
and receiver. If they remain ready, continue the same durable message IDs. Do
not reinstall or replace working configuration.

After a Grok Computer Update, home files usually persist while packages,
processes, Tailscale identity, and SSH host keys may change. Restore only what
is actually missing: OpenSSH/`sshd`, `rsync`, userspace Tailscale and its TCP-22
Serve rule, current peer details, the Grok CLI session, and both VM receivers.
Then repeat the real message/file round trip.
