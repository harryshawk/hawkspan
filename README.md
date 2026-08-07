# HawkSpan-D

Durable coordination between two trusted Macs, usable either as standalone
software or as an optional Codex Personal plugin.

This source tree is HawkSpan 0.3.4. The original 0.1.0 release remains
available under its existing `v0.1.0` tag. See [CHANGELOG.md](CHANGELOG.md).

HawkSpan provides:

- SQLite-backed immutable message, job, artifact, and audit records;
- acknowledged task messages;
- durable peer-task wakeup so an idle task can resume without the owner relaying
  the instruction;
- durable job state transitions for identity, recovery, and idempotency;
- SHA-256 artifact registration and verification;
- collision-safe artifact filenames derived from immutable artifact IDs, with
  changed or missing registered sources rejected instead of retried forever;
- resumable `rsync` delivery over SSH with automatic Apple-rsync fallback;
- primary and fallback private routes;
- broad audited command execution on either trusted Mac, including through the
  peer tool bridge;
- immutable retry of queued messages after either Mac is temporarily offline;
- a two-minute background launch agent that drains the durable outbox after a
  peer or route returns;
- SimpleTuner queue, dataset, process, and log inspection;
- checkpoint-retention and preserved-checkpoint audits, with a default minimum
  of 10 for newly prepared queue configs;
- hash-bound Draw Things direct-import/conversion handoffs that record the
  actual application version, base model, imported LoRA revision, and any
  conversion provenance before controlled validation;
- scoped adapters for starting, stopping, and packaging configured training jobs;
- exact-revision readiness fingerprints binding source images, captions,
  training config, backend config, readiness policy, and validation prompts;
- non-Documents runtime staging so an approved queue can survive screen locks
  without blocking on macOS Documents privacy/FileProvider access;
- five-minute autonomous M4 packet sending and M2 packet receiving that do not
  consume Codex heartbeats or tokens.

## Run with or without the Codex plugin

Both modes run the same HawkSpan release, services, queues, state, security
checks, and MCP implementation. Standalone mode provides the command-line and
local browser control surfaces without registering HawkSpan in Codex. The
optional Personal plugin adds automatic Codex discovery of HawkSpan's MCP tools
and bundled skills; it does not replace or reimplement the standalone runtime.

See [Running HawkSpan with or without the Codex plugin](docs/CODEX-PLUGIN-OPTIONS.md)
for setup choices, advantages, and tradeoffs.

Runtime state defaults to `~/.hawkspan`. Configuration is read from
`~/.hawkspan/config.json`. `~/.hawkspan/installed-revision.json` is the sole
authority for the active immutable release. Activation regenerates the live
environment, configuration paths, launchd files, and the stable
`~/.local/share/hawkspan/current` service link from that record.

Activate an immutable installed release, then start and verify its services:

```sh
node scripts/activate-release.mjs --release-root "$PWD" --revision RELEASE_ID
node scripts/hawkspan-startup.mjs
node scripts/audit-release-authority.mjs
```

Before packaging or publishing a candidate, run the complete fail-closed gate:

```sh
scripts/check-release.sh
```

The gate rejects predecessor runtime identifiers, dependencies, symbolic links,
hard links, or incorrect HawkSpan plugin/MCP identity before running the full
test suite. Release activation enforces the same separation invariant.

Startup fails instead of repairing paths when any live file disagrees with the
installed-revision authority. Peer operations discover the peer's active
release from its own authority record; no remote release executable path is
stored locally.

`run_command` is the general trusted-machine control surface. Routine status,
file, configuration, packaging, and maintenance commands run directly and are
recorded in the audit database. Routine private M2/M4 messages,
acknowledgements, retries, outbox flushing, and peer task wakeups are
pre-authorized local IPC and must not trigger one approval per message. The
active user instruction authorizes its in-scope training start or stop; the
durable job identifies the operation and supports recovery rather than adding
a second permission ceremony. Deletion, publishing, and materially broader
work still require an explicit user instruction.

The M4 configuration includes scoped adapters for exact manifest job IDs.
Start refuses when any training is already active; stop can signal only a
process group previously launched and recorded by that adapter; package
refuses while training is active and operates only on an existing manifest
job. Start also recomputes readiness and refuses a changed revision
fingerprint. Configuration controls whether each adapter is enabled.

`lora_automation` supports `stage-runtime-job` for cloning one prepared,
versioned revision to an internal runtime root outside `Documents`. It
rewrites only cloned config/backend/cache/output paths, preserves the
pre-overlay captions, writes a source and overlay SHA-256 inventory, prepares
a runtime-specific HawkSpan-D config, and runs readiness. It never starts
training. `scheduler-enqueue` separately requires a durable authorized
training job and the exact readiness fingerprint.

Checkpoint recovery is also exact-revision gated. A recovery preparation names
an explicit complete checkpoint in both `config.json` and the readiness policy.
Readiness verifies its required optimizer/scheduler/training-state/LoRA files
and folds a deterministic checkpoint-tree SHA-256 into the authorization
fingerprint. Runtime staging preserves that binding; it never silently resumes
an unbound or incomplete checkpoint.

`draw-things-plan` selects the registry's recommended checkpoint (or the final
LoRA), hashes the exact weights, and emits a Draw Things import plus fixed
validation handoff. `draw-things-ingest` refuses missing files, hash drift,
unrecorded conversion, or incomplete application/base-model provenance.
Successful import is only a prerequisite; the fixed validation suite must
still be rendered and ingested before a checkpoint is accepted. Validation
ingestion binds the saved plan SHA-256, exact checkpoint/LoRA SHA-256, unchanged
fixed settings, common seed set, actual render files, scores, and live Draw
Things metadata.

The dedicated adapters remain useful for repeatable SimpleTuner operations, but
they are not a restriction on routine coordination. M2 can invoke
`run_command` on M4 through `peer_call_tool`, and vice versa, over Thunderbolt
with Ethernet fallback.

HawkSpan also provides an application-neutral durable queue registry. Queues
can be created for messages, verified artifacts, audited commands, or any
registered application tool. Each queue owns its concurrency, priority,
ordering, retries, leases, and pause/resume state. The persistent supervisor
runs queues independently, so a large artifact cannot block a message or an
unrelated application. See [docs/QUEUE-REGISTRY.md](docs/QUEUE-REGISTRY.md).

`lora-scheduler.py` is the sole SimpleTuner lifecycle queue. Training,
packaging, artifact return, and receipt confirmation are phases of that one
durable job. Generic queues cannot be created with SimpleTuner lifecycle tools.
HawkSpan contains no time-window or idle admission gate.

Queue control is deliberately separate from individual-job control:

- `pause-job` prevents one target from launching without affecting other jobs.
- `resume-job` makes that target eligible again.
- `skip-job` bypasses that target until an explicit retry makes it eligible.
- `retry-job` makes a failed or stopped target eligible and resets its attempt
  intent.
- `pause-queue` prevents new launches and stops the exact active managed target,
  preserving its checkpoints; `resume-queue` reopens admission but does not
  silently authorize a stopped target.
- `trainer_stop_authorized_job` terminates only the adapter-recorded process
  group for its exact target. It records that target as stopped and does not
  pause the queue.

Every `trainer_start_authorized_job` request must provide the exact 64-character
revision fingerprint. Initial starts and explicit resumes therefore use the
same dataset/config revision guard enforced by the local trainer adapter.

The authoritative queue control files are under
`~/.hawkspan/lora-scheduler/`, including `queue-control.json` and one
file per target under `jobs/`. No alternate queue or pause-marker location is
scheduling authority.

The `trainer_queue_control` MCP tool exposes these controls over the normal
Thunderbolt-primary/Ethernet-fallback peer bridge. `status` is the recovery
source for queue and per-job intent; conversational memory is not.

Verified M4 LoRA return packets land in `~/M4-LoRA-Incoming`. The M2 receiver
copies to the configured artifact destination, verifies size and SHA-256,
writes a receipt without opening or auditing package contents, and removes only
the verified staging copy when standing authorization is recorded in
configuration.
The sending job remains in `returning` after transport staging and becomes
complete only after HawkSpan imports that receiver-generated, digest-bound
receipt. Periodic recovery can reconstruct an interrupted return from the
SimpleTuner scheduler record without creating another artifact identity.

Training and final acceptance use two immutable packet identities. A successful
M4 run first returns a `training` packet and releases the single trainer slot,
but the durable job remains `returning / awaiting-validation`. M2 then evaluates
the LoRA with the fixed Draw Things prompts, controls, seeds, and live settings.
After that evidence is ingested back into the run output, the normal package
control creates a separate `validated` packet. Only receipt confirmation for
that validated packet completes the original training job and queue item.

The immutable message body is embedded in the peer wake prompt. The prompt also
provides a direct `call-tool.mjs` fallback for Codex exec environments that do
not load dynamic MCP tools.

Background artifact intake reuses an already verified manifest/database match
instead of hashing every large artifact again on every two-minute pass. This
keeps the link agent responsive when multi-gigabyte training packets exist.
