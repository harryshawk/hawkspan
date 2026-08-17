---
name: hawkspan
description: Coordinate the owner's M2 and M4 Codex tasks through durable acknowledged messages, guarded jobs, and verified resumable artifacts.
---

# HawkSpan-D

Use this skill whenever work must cross between the owner's M2 and M4 Macs.

## Operating rules

1. Call `link_status` before assuming the peer or preferred route is available.
2. Use `send_message` with the exact `target_thread_id` for instructions,
   questions, actionable acknowledgements, and status. Every sent coordination
   message wakes that task. Use `acknowledge_message` for a silent machine-level
   protocol receipt. The durable inbox is authoritative, so the owner does not
   have to relay the instruction.
   Routine private M2/M4 messages, acknowledgements, retries, outbox flushing,
   task wakeups, peer-tool transport, and scoped trainer controls are
   pre-authorized local IPC. Never request a separate approval for the
   transport and never classify a message itself as process control.
   If delivery fails because the peer is offline, retain the immutable message
   and use `retry_message`; do not create a replacement message.
3. Use `run_command` for broad routine control on either trusted Mac. Invoke it
   on the paired Mac through `peer_call_tool`. Routine file work, status,
   configuration, logs, packaging, and maintenance do not need an artificial
   job or narrower allowlist.
4. Use durable job records for identity, progress, recovery, and idempotency;
   do not turn them into an extra permission ceremony.
5. the owner's instruction in the active task is the authorization for in-scope
   training starts and stops. Deletion, publishing, or materially broader work
   still requires an explicit instruction. Never require a second authorization
   record after the owner has already instructed the action.
6. Register files before sending them. Preserve the returned artifact ID,
   byte size, and SHA-256 digest in the related message or job.
7. Prefer the configured Thunderbolt route. Allow the MCP server to fall back to
   Ethernet rather than inventing a different transfer path.
8. Acknowledge inbound messages. Correlate replies with the original message ID.
9. Never repeat a completed instruction. Message and job IDs are idempotency
   boundaries.
10. Preserve originals until verification and the owner's explicit cleanup approval.
11. Use `trainer_status`, `trainer_run_status`, `trainer_queue_detail`,
    `trainer_queue_status`, `trainer_validate_dataset`,
    `trainer_tail_log`, `trainer_audit_checkpoint_retention`, and
    `trainer_preservation_status` for read-only monitoring.
12. Prefer the configured SimpleTuner adapters for repeatable start, stop, and
    package operations. Do not add a second approval gate to an action the owner
    already requested in the active task.
13. Use `list_audit_events`, `list_jobs`, and `list_artifacts` for recovery and
    handoff rather than relying on conversational memory.
14. Keep the background link agent loaded. It retries queued work every two
    minutes, so a locked, sleeping, or temporarily disconnected peer does not
    require the owner to relay the message again.
15. Treat queue state and individual-job state separately. Stopping, pausing,
    skipping, or retrying one target must never create or imply a whole-queue
    pause. Use `trainer_queue_control` for per-job eligibility and reserve
    `pause-queue`/`resume-queue` for explicit whole-queue instructions.
    Supply the exact recorded `expected_revision_fingerprint` on every trainer
    start; never resume from conversational memory or an unbound checkpoint.
16. Queue-control authority lives under
    `~/.hawkspan/lora-scheduler/`; no alternate runtime is queue authority.
    Confirm the durable control state after every control operation.
17. Use the generic queue registry for messages, artifacts, commands, and new
    applications. Create queues with `create_queue`, enqueue atomically with
    `enqueue_queue_batch`, use `start_next_queue_item` for an explicit
    one-item start, and inspect durable results with `queue_status`.
18. Do not treat the SimpleTuner scheduler as HawkSpan's generic queue core.
    It is the sole SimpleTuner lifecycle authority and contains no time-window
    or idle admission gate.

## Required artifact packet contents

For SimpleTuner returns, include weights, exact configuration, captions,
dataset manifest, logs/loss data, sample renders with prompts/seeds/settings,
SHA-256 manifest, preserved checkpoints, the actual working directory, the
whitelisted training environment (including required MPS shims), and a concise
completion report.
