# SimpleTuner queue control

## Authority

`lora-scheduler.py` is the only SimpleTuner lifecycle-queue authority. Its durable state lives
under `~/.hawkspan/lora-scheduler/` so launch agents remain functional
when macOS denies background access to `Documents`.

One item remains in this queue through `queued`, `training`, `packaging`,
`returning`, `receipt-confirmed`, and `completed`. A trainer start is not queue
completion. Packaging and return are phases, never additional SimpleTuner queues.

## Separate control scopes

| Operation | Scope | Effect |
| --- | --- | --- |
| `pause-job` | One target | Makes a queued target ineligible. Use the exact-job stop control for a running target. |
| `resume-job` | One target | Makes it eligible again and records the explicit control call and required reason as the resume authorization event. |
| `skip-job` | One target | Bypasses it while the queue advances. |
| `retry-job` | One target | Makes it eligible for another attempt. |
| `trainer_stop_authorized_job` | One running target | Stops only its recorded process group and preserves the rest of the queue. |
| `pause-queue` | Whole queue | Prevents new launches and stops the exact active managed target while preserving checkpoints. |
| `resume-queue` | Whole queue | Restores admission; a stopped target still requires explicit unchanged-revision resume authorization. |
| `reset-attempts` | One generic queue item | Resets system-induced attempts while preserving identity, payload, priority, and pause state. |

`trainer_queue_control` provides these controls through the HawkSpan-D peer
bridge. Thunderbolt is preferred; Ethernet is the automatic fallback.
Every public trainer start requires the exact recorded revision fingerprint;
the local adapter refuses a changed dataset, caption, control, recipe, policy,
prompt, or selected-checkpoint revision.
No second authorization ceremony or detached authorization file exists.

## Admission policy

HawkSpan does not contain an overnight, idle-time, or automatic time-window
gate. Datasets must be staged as exact-revision runtimes and added as eligible
scheduler entries before training can advance.

## Recovery check

1. Call `link_status`.
2. Call `trainer_queue_control` with `action: status`; it reports the one
   authoritative queue, every item, phase, attempts, control state, and active process.
3. Call `trainer_status` and `trainer_run_status`.
4. If no training is active, distinguish `queue paused`, `job skipped/paused`,
   and `no eligible jobs`.
5. Never infer a whole-queue pause from a stopped individual job.
