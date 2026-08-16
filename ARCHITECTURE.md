# HawkSpan-D architecture

Each Mac has the same plugin, a machine-specific configuration, a SQLite
spool, and a two-minute launch agent.

HawkGrokSpan is a second deployment of the same source, not a third member of
this peer pair. It uses isolated `~/.hawkgrokspan` state and connects only M2
and one trusted Grok VM. Its `message-files` profile filters both MCP discovery
and dispatch to thirteen link, message, acknowledgement, and verified-artifact
tools. It has no command, job, queue, plugin, trainer, or wake surface.

## Transport

- Preferred: Thunderbolt Bridge (`192.0.2.10` ↔ `192.0.2.11`)
- Fallback: direct Ethernet (`198.51.100.10` ↔ `198.51.100.11`)
- Internet: Wi-Fi remains the default route
- Authentication: one dedicated ED25519 key per direction
- Transfer: rsync with partial-file retention and automatic capability
  detection for Apple's older rsync

## Durable records

`~/.hawkspan/spool.sqlite3` stores messages, jobs, artifacts, and audit
events. JSON message envelopes and artifact manifests remain in the adjacent
inbox, outbox, and artifact directories.

The background agent retries queued work. A temporary disconnect, sleep,
screen lock, or stopped SSH service therefore delays delivery without losing
the instruction or creating a duplicate.

Peer wakeups are not sent for acknowledgement envelopes. A per-task remote
lease serializes other wakeups so repeated delivery cannot create concurrent
`codex exec resume` processes for one task.

## Codex coordination

A delivered message is imported from the durable inbox by the peer task. The
configured `codex exec resume` wakeup lets an idle task continue without the owner
relaying the instruction. The peer acknowledges the immutable message ID,
performs authorized work, and replies with the original ID as the correlation
boundary.

Each node targets a persistent CLI-created receiver task on the other Mac, not
an interactive task left open in Codex Desktop. Remote wake is fail-closed
unless the configuration records an exact task UUID, an absolute Codex
executable or reviewed store-selection wrapper, an absolute dedicated receiver
directory, and the `workspace-write` sandbox. HawkSpan clears unrelated Codex
writable roots on every resume and supplies the dedicated directory with `-C`.

## Trusted remote operations

`run_command` is a full shell as the local HawkSpan user. Local and peer use is
available only when the configured directional tool list and broad-command
feature allow it. In controller/worker mode the worker-to-controller direction
defaults closed and requires an explicit `allow_peer_commands` setting. The
receiver enforces its inbound list independently of the sender's outbound
list. Every allowed invocation records the command, working directory, timing,
result, authorization reference, and output sizes in the local audit database.

The `consequential` field classifies the audit entry; it is not a second
authorization ceremony. Trainer lifecycle operations are narrower: they
require the existing durable job to contain recorded owner authorization.
Deletion, publishing, or work broader than the active owner instruction still
requires an explicit owner instruction.

## SimpleTuner control

Read-only tools inspect processes, queues, caption coverage, datasets, and
logs. They also audit checkpoint retention and protected checkpoint clones.
Newly prepared queue configs should retain at least 10 checkpoints. Start,
stop, and package tools can invoke only configured wrapper scripts.
They remain disabled unless both conditions hold:

1. the local configuration explicitly enables that operation; and
2. the durable job contains the owner's explicit authorization evidence.

The M4 adapter validates every target against the queue manifest. Its start
operation refuses concurrent training and records the PID, process group, log,
status file, durable authorization job, and target. Stop verifies that exact
record and command before signaling its process group. Package accepts only a
manifest job and refuses while training is active.

Every start is bound to a readiness SHA-256 covering the dataset, captions,
config, data backend, readiness policy, and fixed validation prompts. The
scheduler stores the same target, durable authorization job, and fingerprint;
it cannot execute an arbitrary command.

Recovery revisions may additionally bind one explicit complete checkpoint.
The readiness fingerprint then includes a deterministic hash of the complete
checkpoint tree. The configured checkpoint and policy checkpoint must match,
and required optimizer, scheduler, training-state, and LoRA files must exist.
Clean revisions continue to omit `resume_from_checkpoint`.

Source and preparation trees may remain under `Documents`, but an approved
training revision is first cloned to an internal non-Documents
runtime root. The stage retains original caption sidecars, optionally overlays
the verified five-variant caption packet, rewrites only the cloned runtime
paths, and re-runs readiness. Training, logs, caches, checkpoints, scheduler
state, control markers, registry, and packet ledger can then stay outside the
macOS Documents privacy boundary through lock and reboot.

## Artifact lifecycle

The sender registers a file and records its size and SHA-256. After resumable
transfer, the sender calculates the remote SHA-256 over SSH. Only a match is
marked delivered. A manifest then lets the receiver independently import and
verify the file. Source cleanup is outside the plugin and requires separate
authorization.

Each remote artifact filename is prefixed by its immutable artifact ID, so two
different revisions with the same source basename cannot overwrite one
another. If a registered source changes or disappears before delivery, that
artifact is terminally marked `source_changed` or `source_missing`; the current
file must be registered as a new immutable artifact. Receivers cache verified
manifest/database matches and do not re-hash multi-gigabyte files on every
background cycle.

HawkGrokSpan additionally requires outgoing files to resolve under configured
exchange roots, rejects symlink escape, sanitizes remote filenames, and rejects
non-regular, oversized, path-escaping, or malformed inbound manifests and
payloads. Its SSH transport requires a dedicated identity, `IdentitiesOnly`,
strict checking against a dedicated `known_hosts`, and no global-known-hosts
fallback. Remote verification selects either `shasum` or Linux `sha256sum`.

## Draw Things validation bridge

The registry selects a recommended checkpoint only from controlled validation
results. A Draw Things handoff binds the exact `.safetensors` SHA-256 and
records the intended base model and fixed validation plan. Direct import is
preferred for SimpleTuner SDXL PEFT output. If conversion is required, the
converted result must retain source hash, tool/version, and command
provenance. Import results and validation results are ingested separately so
successful import cannot be mistaken for successful visual validation.

## Autonomous return packets

The managed SimpleTuner runner creates one packet, records its size and SHA-256,
and registers it with HawkSpan artifact delivery. The periodic link agent
retries only receipts from that managed lifecycle. M2 confirms the transferred
file's identity, size, and SHA-256; that receipt confirmation is the terminal
SimpleTuner phase. HawkSpan does not inspect package contents as part of
transport settlement.

## Generic queue supervision

The SQLite queue registry creates independently managed message, artifact,
command, and registered-tool queues. Atomic claims, expiring worker leases,
per-item attempts, queue-specific retry delays, and process-level worker
restart delays provide recovery without application-specific assumptions.
Thunderbolt-primary/Ethernet-fallback values and supervisor timings are read
from `~/.hawkspan/hawkspan.env`.

The exact-revision `lora-scheduler.py` is the SimpleTuner adapter's sole
application-level authority. It is not a second generic queue implementation,
and it contains no time-window or idle admission gate.
