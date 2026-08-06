# HawkSpan queue registry

HawkSpan queues are application-neutral. A queue is a durable record with its
own adapter, ordering, priority, concurrency, retry policy, and lifecycle.
SimpleTuner uses its one established lifecycle scheduler and is deliberately
excluded from the generic registry. Generic queues cannot use trainer start,
stop, package, or trainer-queue controls as adapters.

## Adapters

- `message`: delivers a durable HawkSpan message.
- `artifact`: transfers and verifies a registered file.
- `command`: invokes audited `run_command`.
- `tool:<name>`: invokes any registered HawkSpan or application-plugin tool
  that is not itself a queue-management tool.

Use `list_queue_adapters` before creating an application queue.

## Queue lifecycle

1. `create_queue` defines a queue and adapter.
2. `enqueue_queue_item` or `enqueue_queue_batch` adds durable work.
3. `start_next_queue_item` synchronously runs one eligible item.
4. The launchd queue supervisor runs all active queues independently up to each
   queue's concurrency.
5. `queue_status` reports item state, attempts, leases, results, errors, and
   the next retry time.
6. `queue_control` pauses or resumes a queue, clears only pending work, or
   pauses, resumes, cancels, skips, retries, or reprioritizes one item.
7. `delete_queue` accepts only an empty queue.

Batch item insertion is atomic. Claims use SQLite write transactions, renewable
leases, and a unique generation token, so a reclaimed stale worker cannot
settle the new claim. An expired worker lease is recovered as a retry.
Application failures use durable full-jitter retry delays and a maximum-attempt
limit; worker-process failures use the supervisor restart delays.

Each queue enforces configured pending-item and payload-byte admission limits.
Queue summaries expose the oldest pending item and its age.

## Network behavior

Messages and artifacts prefer Thunderbolt and fall back to Ethernet. Retry,
connection, keepalive, cycle timeout, and primary-route reprobe values live in
`~/.hawkspan/hawkspan.env`. A large artifact runs on its own queue and cannot
block the message queue.

## Application queues

An application package registers normal HawkSpan tools. Create a queue with
`adapter: "tool:<registered-tool>"`; each item's payload is passed to that
tool. The tool must report terminal success or failure for that invocation.
Long-running application lifecycle semantics remain in their application
adapter. The built-in SimpleTuner lifecycle is handled only by its dedicated
scheduler.
