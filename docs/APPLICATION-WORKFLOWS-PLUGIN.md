# SimpleTuner application workflows

The public `application-workflows` example is a sanitized SimpleTuner 4.5.x
worker plugin with one optional controller-only return-packet intake operation.
It preserves HawkSpan's same-owner, high-trust model and controller/worker
asymmetry. Generic application-plugin extensibility remains separate in
[APPLICATION-PLUGINS.md](APPLICATION-PLUGINS.md).

The plugin is inert by default and consequential feature switches are false.
Configuring the local trainer root does not start SimpleTuner or enable an
operation. Separately enabled local trainer operations use only the reviewed
commands in the plugin's `bin/` directory and never fall back to broad
command execution.
`local_trainer.timeout_ms` remains the short start/stop adapter limit, with a
30-second maximum. Packet construction uses the separate
`local_trainer.package_timeout_ms`, which defaults to one hour and accepts
values from 30 seconds through four hours for large verified return packets.
The `packet_intake` feature is also disabled by default. When separately enabled
on a controller configuration, its local-only operation joins HawkSpan's
verified artifact receipt to the bundled packet receiver and a durable receipt
message. It does not add a peer-callable application operation.

Evidence in this guide uses three explicit levels:

- **Implemented + synthetic-tested** means the public code and bounded fake-runner
  or temporary-root tests pass; it is not real-machine proof.
- **Real-pair proven** means the named behavior was directly observed on the M2/M4
  installation.
- **Real-pair pending** means the implementation exists or the workflow has begun,
  but its required terminal observation has not completed.

## Machine settings and transport

Copy only the needed placeholders from
`examples/plugins/application-workflows/hawkspan.env.example` into the one
owner-only `~/.hawkspan/hawkspan.env` file. Plugin entry configuration contains
only references to those allowlisted names. `HAWKSPAN_SIMPLETUNER_ROOT` names
the local installation containing `.venv/bin/simpletuner`; the three trainer
script variables name the reviewed plugin commands.

The configured inbox, dataset, recipe, output, state, and disk roots must be
absolute, existing, non-symbolic-link directories. Paths, job IDs, configs,
datasets, events, and artifact contents are local
installation data and must not enter public source, examples, logs, or release
receipts.

## Exact local execution and scheduling

The public trainer commands preserve Mac Link's exact-job behavior. Start
requires one staged target and its unchanged revision fingerprint, refuses an
already active trainer, and records the managed PID and process group. Stop
signals and verifies only descendants of that exact recorded controller without
terminating the controller before it records `stopped`. Package requires the
same authoritative record to be terminal. A completed run must include its
final LoRA and validation renders; a stopped or failed recovery packet must
include at least one non-empty model checkpoint. Packaging verifies the packet,
registers it with HawkSpan's existing artifact store, and returns the artifact
ID and SHA-256. Sending that artifact remains a separate `send_artifact`
operation.
When package is invoked with `peer_call_tool`, set that call's `timeout_ms` at
least as high as the configured package timeout. HawkSpan forwards the validated
peer timeout to the remote call process; both paths allow up to four hours.

For a run started by `training_local_trainer_start`, the authoritative evidence
is its trainer-control record, exact managed PID/process group, process
reconciliation, and bounded log. `training_local_process_status`, the exact
trainer record, and `training_tail_local_log` describe that live process.

The current release and Draw Things acceptance workload is
`hawkspan-robot-lora-acceptance-v1`: a conventional SDXL LoRA trained from 20
public robot images and their reviewed caption sidecars. The separate ControlNet
example trains a ControlNet PEFT LoHa adapter with SimpleTuner 4.5. It exercises
the conditioning workflow but is not a substitute for the conventional LoRA or
proof of Draw Things interoperability.

The implemented packet builder is designed to include the exact staged recipe,
backend, readiness policy, validation prompts, targets, captions, conditioning
inputs, trainer record, log, available final LoRA or recovery checkpoints, and
SHA-256 inventory. The packet receiver verifies
the archive and exact identity before writing its receipt and registry. It
never authorizes deletion of the worker source; removal of a verified receiver
staging copy requires separately recorded standing authorization.
Builder and receiver behavior, including exact inventory and failure handling,
is covered by local integrity checks. Real packet delivery and receipt remain
pending until verified on the installed worker.

## Datasets, checkpoints, and artifacts

The reviewed product default retains checkpoint milestones 600, 800, 900,
1000, and 1200. These defaults may be overridden only with unique positive
step numbers. The selected milestone policy is retained with local readiness
and checkpoint inspection evidence. The
real two-Mac acceptance run is deliberately narrower: it waits for checkpoints
600 and 900, then separately requires the exact configured final result to be
returned and hash-verified. This reduces acceptance cost without weakening the
product default.

The public end-to-end path uses a HawkSpan artifact containing a bounded JSON
dataset bundle. The bundle has `schema_version:1`, kind
`hawkspan.dataset-bundle`, an exact manifest, and one entry per file. Small
fixtures may embed strict base64. Practical datasets should reference a
separately delivered HawkSpan artifact ID and SHA-256 for each file. HawkSpan
verifies the bundle artifact and every referenced file artifact before copying
regular files into a temporary directory beneath the configured dataset root.
It verifies exact relative paths, sizes, SHA-256 hashes, count, total size,
manifest revision, and a non-empty sidecar caption for every image, then
atomically installs the dataset. It never executes shell, tar, or archive
content. Links, special files, additions, omissions, root escapes, duplicate
paths, and mismatches fail closed. Repeating an identical import is idempotent.

Checkpoint listing, retention audit, preservation inspection, and packet
inventory code are implemented and synthetic-tested. The current real run has
proven startup validation and optimizer execution, but this guide does not claim
that its final required checkpoints, final LoRA, packet, delivery, or receipt are
complete.

## Installation and testing

1. Run `scripts/check-release.sh`, inspect the plugin source and manifest, and
   prepare the worker with `SIMPLETUNER-SETUP.md`.
2. Create owner-only workload roots and add only their values to
   `~/.hawkspan/hawkspan.env`.
3. Install the reviewed plugin on the worker role. Copy the complete object
   from `examples/plugins/application-workflows/config.example.json` into
   `application_plugins.entries.application-workflows.configuration`; plugin
   installation and quick-start presets intentionally do not inject local
   configuration.
4. Enable only `inspect` first and call `training_local_process_status`.
5. Preview `simpletuner-controller` on the working Mac and
   `headless-simpletuner-worker` on the headless Mac. They change only role,
   capability, peer-tool, and same-plugin operation restrictions. Presets may
   add only the fixed safe core coordination subset: durable job create/update/
   list and artifact receipt. They can never add arbitrary core tools.
6. Enable staging and each consequential operation separately after review.
7. On the worker, configure both the global ceiling and this exact plugin
   entry's core-tool allowlist to `verify_artifact` and `register_artifact`.
   Delivery remains a separate universal HawkSpan `send_artifact` operation.
   A controller using `training_receive_return_packet` instead requires
   `receive_artifacts`, `verify_artifact`, and `send_message` in both allowlists,
   sets the plugin configuration role to `controller`, and explicitly enables
   `packet_intake` plus the `workload-packet-intake` feature flag. Its configured
   `state_root` must resolve to HawkSpan's own state root so intake can require
   the received ZIP to be a direct file under HawkSpan's artifact directory.

## Real-workflow acceptance

Current evidence is deliberately split:

- **Real-pair proven:** public dataset artifact transfer/import, exact-revision
  readiness, immutable runtime staging, exact authorized direct start,
  trainer-process/log monitoring, startup validation renders, and optimizer work.
- **Implemented + synthetic-tested:** checkpoint evidence operations,
  terminal-run packet builder, packet receiver/registry,
  final artifact delivery orchestration, and idempotent/fail-closed paths.
- **Real-pair pending:** current run completion, final checkpoint and LoRA
  verification, final packet construction, delivery, and M2 receipt.

Route interruption/restoration, offline retry, wake/resume, and a public
unauthenticated installation are outside this workflow's completed evidence and
are not claimed here.

The public robot packet acceptance uses the local trainer operations and is the
authoritative Mac Link-parity path: immutable staging, exact authorized local
start, bounded monitoring, terminal-run packet construction, HawkSpan artifact
delivery, and verified receipt.

## Bundled robot examples

`examples/simpletuner/hawkspan-robots/` provides two public, independently
validated starting points for this workflow:

- a conventional SDXL LoRA release/Draw Things acceptance example with 20
  source JPGs and reviewed seven-line caption alternatives; and
- a separate SDXL ControlNet PEFT LoHa trainer example with the same 20 target
  JPGs paired by basename with 20 deterministic Canny conditioning PNGs.

Both examples use acceptance checkpoints 600 and 900. Their worker policies
enable exact local trainer start, stop, and package operations. Validate
the bundle, copy the chosen example to owner-only local workload state, render
all placeholders there, and use the local trainer path above. Training caches,
configs, models, receipts, and outputs must never be written to or committed
from the public repository. Twenty images are sufficient to reproduce and
exercise the pipeline, not to claim a production-quality general model.
