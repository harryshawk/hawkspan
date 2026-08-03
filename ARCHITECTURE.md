# Architecture

Each peer runs the same stdio MCP server and maintains local state under
`~/.hawkspan`. SQLite stores messages, jobs, artifact metadata, and audit
events. JSON envelopes and artifact manifests form the durable transfer spool.

## Transport

The ordered `peer.primary_host` and `peer.fallback_host` settings define route
preference. A typical deployment uses Thunderbolt Bridge first and a private
Ethernet link second. SSH carries commands and small control files; `rsync`
provides resumable artifact delivery. A delivery is complete only after the
receiver reports the expected byte size and SHA-256 digest.

## Coordination mode

Messages have immutable IDs, correlation IDs, explicit direction and state,
and optional wakeup delivery. Acknowledgements refer to the original message.
Jobs provide durable identity, authorization evidence, state transitions, and
idempotency across agent restarts.

## Remote-control mode

`peer_call_tool` invokes an allowlisted HawkSpan tool on the peer. Its
`run_command` target is broad by design for same-owner trusted machines and
records command, working directory, timing, exit state, and output sizes in the
audit database. HawkSpan does not claim process sandboxing or least-privilege
command policy.

## Artifact mode

Registration binds a local path, immutable artifact ID, size, and SHA-256.
Transfer uses a collision-safe remote name and verifies the remote digest.
Receipt imports verify delivered manifests before accepting local files.

## Background retry

The optional launch agent calls `flush_outbox` every two minutes. Queue state
is durable, so a sleeping or disconnected peer does not require a new message
or artifact identity.

## Application-plugin layer

Validated optional plugins contribute generated MCP tools above the
coordination core. Manifests declare roles, origins, flags, schemas, and
annotations. Configuration can narrow those declarations. Durable plugin-run
records support cancellation and restart recovery. Application-specific
behavior, including rendering or drawing adapters, remains outside the core.

## Local HTML client

The default HTML listener binds only to `127.0.0.1`. It dispatches through the
same internal tool map as MCP, with an additional local allowlist and
per-process token. Users may change its loopback port or disable it.
