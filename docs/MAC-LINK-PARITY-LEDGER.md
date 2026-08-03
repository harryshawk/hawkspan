# Mac Link to HawkSpan parity ledger

This ledger defines the release scope. Mac Link behavior is authoritative.
HawkSpan may generalize private names, paths, configuration, and packaging, but
it must not replace working behavior with a new architecture. Automated tests
are supporting evidence; only a real two-Mac run proves operational parity.

Status meanings:

- **Ported**: the Mac Link behavior is present in public HawkSpan form.
- **Partial**: recognizable behavior is present, but material Mac Link behavior is missing.
- **Missing**: no operational HawkSpan equivalent exists.
- **Implemented + synthetic-tested**: code and bounded automated tests exist, but
  they do not prove operation on the real pair.
- **Real-pair proven**: direct evidence from the M2/M4 installation demonstrates
  the stated behavior. This label applies only to the behavior named in that row.
- **Real-pair pending**: implementation may exist, but the required real-pair
  observation has not completed.
- **Disconnected**: an API or state surface exists, but no operational consumer or producer completes its workflow.

## General platform

| Mac Link capability | HawkSpan status | Evidence | Required action |
|---|---|---|---|
| Link and route status | Implemented + synthetic-tested; normal real-pair connectivity proven; interruption/fallback/restoration pending | `scripts/mcp-server.mjs`: `linkStatus`, `peerCandidates` | Preserve the normal-link evidence; do not claim route interruption until the physical sequence is completed. |
| Audited command execution | Implemented + synthetic-tested; real-pair peer tool calls proven for the acceptance workflow | `scripts/mcp-server.mjs`: `runCommand`, `peerCallTool` | Preserve the bounded real evidence; do not broaden it into a claim that every command/audit scenario passed. |
| Durable messaging | Implemented + synthetic-tested; real-pair pending | `scripts/mcp-server.mjs`: `sendMessage`, `receiveMessages`, `listMessages` | Send one real message and verify persistence on both Macs. |
| Acknowledgements | Implemented + synthetic-tested; real-pair pending | `scripts/mcp-server.mjs`: `acknowledgeMessage` and correlated message state | Verify one real correlated acknowledgement reaches terminal state. |
| Peer wakeup and resume | Implemented + synthetic-tested; real-pair pending | `scripts/mcp-server.mjs`: `wakePeerThread` | Verify real resume, lease cleanup, wake log, and acknowledgement. |
| Durable jobs and recovery | Implemented + synthetic-tested; exact authorization jobs used on the real pair; full recovery lifecycle pending | `scripts/mcp-server.mjs`: `createJob`, `updateJobStatus`, `listJobs` | Complete and inspect the real authorized lifecycle without claiming wake/recovery proof. |
| Offline retry and outbox | Implemented + synthetic-tested; real-pair pending | `scripts/mcp-server.mjs`: `retryMessage`, `flushOutbox`; `scripts/link-agent.mjs` | Queue during an outage and prove autonomous delivery after recovery. |
| Immutable audit history | Implemented + synthetic-tested with public redaction; complete real-pair audit review pending | `scripts/mcp-server.mjs`: `audit`, `listAuditEvents` | Verify complete useful evidence remains after redaction. |

## Artifacts and transport

| Mac Link capability | HawkSpan status | Evidence | Required action |
|---|---|---|---|
| Artifact registration and SHA-256 identity | Implemented + synthetic-tested; real dataset artifact transfer/import proven | `scripts/mcp-server.mjs`: `registerArtifact`, `verifyArtifact` | Preserve the real dataset evidence; final result-packet proof remains separate. |
| Resumable artifact delivery | Implemented + synthetic-tested; ordinary real transfer proven; interruption/retry pending | `scripts/mcp-server.mjs`: `sendArtifact`, `rsyncFile` | Do not claim interrupted-transfer recovery until it is exercised. |
| Generic artifact receipt state | Implemented + synthetic-tested; real dataset receipt/import proven | `scripts/mcp-server.mjs`: `receiveArtifacts` | Keep generic receipt evidence distinct from the unfinished final workload packet. |
| Workload packet builder, receipt, and registry | Implemented + synthetic-tested; final real packet pending | `hawkspan-packet-builder.py`, `hawkspan-packet-receiver.mjs`, and their tests verify inventory, exact identity, archive hash, and atomic receipt/registry placement | Wait for the current run to complete, then build and receive its exact packet. |
| Workload packet delivery | Implemented through core artifact delivery + synthetic-tested; final real packet pending | Packet builder plus HawkSpan registration, delivery, and receiver operations preserve the Mac Link chain without another transport | Deliver and verify only the completed run's packet. |

## SimpleTuner application capability

| Mac Link capability | HawkSpan status | Evidence | Required action |
|---|---|---|---|
| Dataset preflight and inspection | Partial | `examples/plugins/application-workflows/plugin.mjs` | Compare and port missing Mac Link preflight evidence without private dataset assumptions. |
| Installed environment inspection | Ported for the release workload | Worker disk/process/capability operations plus packet evidence verify SimpleTuner 4.5.x, corrected installed source, Python environment, caches, and output roots | Preserve; verify the completed packet evidence. |
| Exact-revision readiness | Partial; implemented + synthetic-tested; real-pair proven for the current acceptance revision | `training_readiness` | Preserve the public fingerprint model; recovery/checkpoint validation remains separate. |
| Immutable runtime staging | Partial; implemented + synthetic-tested; real-pair proven for the current acceptance job | `training_stage_runtime_job` | Preserve the exact staged manifest and revision evidence; do not claim unimplemented recovery behavior. |
| Exact authorized start | Ported; implemented + synthetic-tested; real-pair proven | `training_local_trainer_start` records one revision-bound process | Preserve the current direct-run evidence. |
| Exact authorized stop | Ported, unproven | `training_local_trainer_stop` reconciles and signals only the exact recorded process group | Verify against the real managed acceptance process. |
| Package terminal run | Ported; local checks pass; real packet pending | Packaging requires an authoritative terminal trainer record, complete final-model evidence for success, or checkpoint evidence for an interrupted recovery packet | Verify both the stopped recovery packet and the eventual completed packet. |
| Direct process and log status | Implemented + synthetic-tested; real-pair proven | The trainer-control record, managed PID/process group, process reconciliation, and bounded local log are authoritative for a direct trainer run | Continue monitoring the exact record and log through terminal state. |
| Checkpoint evidence and preservation | Partial; checkpoint listing/audit, preservation, and packet-evidence code exist and are synthetic-tested; final real evidence pending | Checkpoint operations and packet builder inventory exact checkpoint/output files | Verify the current run's actual checkpoints and final output after completion. |
| Recovery planning and checkpoint validation | Missing | Present in Mac Link automation, absent from HawkSpan workflow | Port after the base real training path works. |
| Real SimpleTuner execution | Live-proven through validation and optimizer steps; completion pending | The exact public trainer command produced four real ControlNet validation renders and entered the 900-step optimizer loop on the worker | Preserve the running evidence; complete and package the bounded job. |
| Return-packet construction and ledger | Ported, unproven | Public builder records targets, captions, ControlNet conditioning, config, logs, available final LoRA or recovery checkpoints, hashes, identity, and new-only ledger | Verify the real packet and idempotent reuse. |
| Artifact delivery and M2 verification | Generic primitives ported; workflow unproven | HawkSpan core artifact tools are not connected to a real SimpleTuner packet | Send and verify the real acceptance artifact and receipt. |

The authoritative operational chain is:

```text
preflight
-> exact-revision readiness
-> immutable runtime staging
-> exact authorized start
-> real SimpleTuner execution
-> status, logs, and checkpoint preservation
-> verified return-packet construction
-> HawkSpan artifact delivery
-> M2 receipt and verification
```

HawkSpan implements exact single-job execution, scheduling, checkpoint evidence,
packet construction, delivery, and receipt, with bounded synthetic tests for
those paths. On the real pair, the current direct run has proven dataset import,
exact readiness and staging, authorized start, process/log monitoring, startup
validation, and optimizer work. Completion, final checkpoint/output evidence,
packet construction, delivery, and M2 receipt remain pending.

## Public usability and release support

| Area | Status | Required action |
|---|---|---|
| Public configuration | Generalized and improved | Preserve strict local machine settings and remove unproven trainer-command settings as the SimpleTuner port is corrected. |
| Installation and uninstall | Implemented, unproven on clean real pair | Follow the documented procedure on both Macs and record every discrepancy. |
| Core logging and local diagnostics | Implemented, unproven | Test bad keys, route failures, malformed configuration, queued artifacts, and stopped agents. |
| Workload logging | Partial | Restore the operational trainer and packet-agent logs used by Mac Link. |
| Help | Substantially implemented | Validate all instructions during real installation. |
| Troubleshooting | Implemented for observed release failures | Installation, local-control, SimpleTuner setup, bounded trainer logs, and compatibility-patch guidance record the failures observed during acceptance. |
| Release manifest and exact tree | Passed for the neutral candidate | Release ID `tree-sha256:e3112d8bb01faad43d83fa5d02e89c619606d1360b10803c6b667597312ec248`. Preserve this as candidate evidence; later content changes require a new manifest and gate. |
| Public history, privacy, and release gate | Passed in the neutral candidate and a fresh staging clone | Neutral staging commit `8ddbfa342a41222bda6767c69e2a15113fcba9b3`; the complete gate passed in both contexts. This does not prove a public unauthenticated install. |

## Release evidence required

The neutral candidate's release tree and history gate are complete. Operational
release evidence still must show:

1. A real M2-to-M4 message, acknowledgement, wakeup, and durable job lifecycle.
2. A real harmless remote command with complete audit evidence.
3. Real primary-route interruption, fallback, and primary restoration.
4. Real queued retry after temporary peer unavailability.
5. A real verified artifact transfer and receiver import.
6. One bounded real SimpleTuner job completing the full operational chain above.
7. Installation, help, logging, diagnostics, and troubleshooting corrected from real use.
8. A public unauthenticated clone/archive installation check, if that is required
   before publication; it has not yet been claimed as passed.
