---
name: hawkspan-queues
description: Operate, inspect, troubleshoot, and extend HawkSpan's durable generic queues for messages, artifacts, commands, and registered application tools. Use when creating or configuring queues, enqueuing one item or an atomic batch, controlling queue or item state, reviewing retries and leases, running a queue manually, diagnosing supervisor behavior, or adding an application-specific queue adapter.
---

# HawkSpan Queues

Successful managed training is a train-package-return lifecycle, not two
independent queue items. A zero exit with a valid final LoRA builds and hashes
the packet, registers it once, and sends it through `hawkspan-artifacts`.
`link-agent.mjs` rescans only automatic-return receipts created by this lifecycle
and requeues incomplete returns. It never enrolls historical packet-ledger entries.
Do not enqueue a separate package item for a running training target.

`lora-scheduler.py` is the one SimpleTuner lifecycle queue. Its item remains
unfinished through `training`, `packaging`, and `returning`; only a verified
receipt produces `receipt-confirmed` and `completed`. Call
`trainer_queue_control {"action":"status"}` for that queue. Generic queue
creation with trainer start, stop, package, or control adapters is rejected.
The built-in queue cannot be renamed, reconfigured, archived, cleared, or
deleted through generic queue tools.

Treat the generic registry as application-neutral infrastructure. Do not add
another SimpleTuner queue to it.

## Start with status

1. Call `link_status {}` to verify routes and read the queue summary.
2. Call `list_queues {}` to see queue policies and state counts.
3. Call `queue_status {"queue_id":"QUEUE"}` before changing a queue.
4. Call `list_queue_adapters {}` before creating an application queue.

Do not infer that `link-agent` is broken merely because it is not continuously
running. It is a periodic/oneshot service. The queue supervisor is persistent.

## Create and enqueue

Create a queue with an immutable identity and adapter:

```json
{"queue_id":"renders","name":"Render jobs","kind":"application","adapter":"tool:render_image","concurrency":2,"ordering":"priority","maximum_attempts":5,"maximum_pending_items":10000,"maximum_payload_bytes":1048576,"retry_delays_ms":[2000,5000,10000,20000]}
```

Call that JSON with `create_queue`. Repeating the same identity is idempotent;
attempting to replace its adapter or kind is rejected.

Prefer stable, intent-specific item IDs:

```json
{"queue_id":"renders","item_id":"campaign-42-frame-001","priority":100,"payload":{"preset":"hero","source":"/absolute/input.png"}}
```

Call that JSON with `enqueue_queue_item`. The same ID and payload returns the
existing item. The same ID with changed payload is rejected.

Use `enqueue_queue_batch` when all queue-item rows must commit together:

```json
{"queue_id":"renders","items":[{"item_id":"frame-001","payload":{"frame":1}},{"item_id":"frame-002","payload":{"frame":2}}]}
```

Atomicity includes queue insertion and built-in message or artifact
registration. A rejected batch retains none of its new queue rows,
registrations, audit rows, or message envelopes.

## Control work

Use `queue_control` with one of these actions:

- Queue: `pause-queue`, `resume-queue`, `archive-queue`, `clear-pending`
- Item: `pause-item`, `resume-item`, `cancel-item`, `skip-item`,
  `retry-item`, `set-priority`

Examples:

```json
{"queue_id":"renders","action":"pause-queue","reason":"operator maintenance"}
```

```json
{"queue_id":"renders","action":"retry-item","item_id":"frame-002","reason":"dependency restored"}
```

```json
{"queue_id":"renders","action":"set-priority","item_id":"frame-002","priority":10}
```

`clear-pending` cancels queued, paused, and failed items. It does not erase
history or stop a running adapter. `delete_queue` succeeds only when the queue
contains no items; normally archive a historical queue instead.

## Run and supervise

- Let the persistent queue supervisor run every active queue up to its own
  concurrency.
- Use `start_next_queue_item` for one explicit eligible item.
- Use `supervise_queue` only for bounded manual processing or diagnostics.
- Inspect completion, attempts, lease owner/expiry, error, result, and next
  retry with `queue_status`.

The contract is at-least-once. Require idempotent adapter behavior because a
worker failure or expired lease can repeat an invocation. A unique claim token
fences stale workers after recovery. Every adapter executes in a child process,
so the supervisor can renew its lease while the operation runs. Adapter tools
must still define their own bounded operation timeout; do not describe arbitrary
`command` payloads as exactly-once.

## Architecture

```text
producer or agent
    -> named SQLite queue (policy + durable items)
    -> atomic claim with a time-bounded lease
    -> queue supervisor worker slot
    -> built-in adapter or tool:<registered-tool>
    -> local action or TB-primary/Ethernet-fallback delivery
    -> durable completion, retry, or terminal failure
```

Each queue owns ordering, priority, concurrency, maximum attempts, retry
delays, and lifecycle. Worker-process restart backoff is separate from item
retry backoff. Read `references/commands-and-extension.md` for all environment
controls and extension steps.

## Extend safely

1. Prefer a reviewed application plugin over adding application logic to
   `queue-registry.mjs`.
2. Define one bounded operation in `hawkspan-plugin.json` and implement it in
   the plugin module. Return terminal success or throw/report failure.
3. Install and validate the plugin, then confirm `tool:<operation>` appears in
   `list_queue_adapters`.
4. Create a queue that names that adapter; treat each item payload as the
   operation's complete replayable input.
5. Make side effects idempotent using the item or operation ID. Preserve enough
   result data to reconcile an uncertain timeout.
6. Add tests for duplicate submission, retry, worker loss, invalid payload,
   queue pause, terminal failure, and a long operation whose lease heartbeat is
   observed while it remains in progress.

Read `docs/QUEUE-BEST-PRACTICES.md` in the HawkSpan source before changing
delivery semantics, leases, retry policy, dead-letter handling, or admission
control.
