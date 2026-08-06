# Commands and extension reference

## MCP commands

| Command | Purpose |
| --- | --- |
| `list_queue_adapters` | List built-in and registered `tool:*` adapters |
| `create_queue` | Create an immutable queue identity and adapter |
| `configure_queue` | Change name, concurrency, priority, ordering, attempts, admission limits, retry delays, or metadata |
| `list_queues` | List queue policies, counts by state, and next eligible retry |
| `queue_status` | List one queue's ordered items and durable execution state |
| `enqueue_queue_item` | Idempotently insert one item |
| `enqueue_queue_batch` | Atomically insert 1-1000 queue-item rows |
| `queue_control` | Control a queue or one non-running item |
| `start_next_queue_item` | Claim and execute one eligible item |
| `supervise_queue` | Process a bounded number of eligible items |
| `delete_queue` | Delete a queue only when it has zero item records |

Built-in adapters:

- `message`: payload contains `message_id`, or `subject` and `body` for durable creation.
- `artifact`: payload contains `artifact_id`, or an absolute `path` for registration.
- `command`: payload follows `run_command`, including `command`, optional `cwd`, and timeouts.
- `tool:<name>`: payload is passed as arguments to the registered HawkSpan tool.

The SimpleTuner lifecycle queue is not part of the generic registry. It is one
built-in immutable queue and cannot be created, renamed, reconfigured,
archived, cleared, or deleted with these commands.

## Queue and item states

Queue states: `running`, `paused`, `archived`.

Item states: `queued`, `running`, `paused`, `completed`, `failed`,
`cancelled`, `skipped`.

Only the lease owner may complete or fail a running item. Retry exhaustion
produces terminal `failed`; `retry-item` explicitly redrives it and resets its
attempt count.

## Environment controls

Set these in `~/.hawkspan/hawkspan.env` and keep the file mode `0600`:

| Variable | Meaning |
| --- | --- |
| `HAWKSPAN_QUEUE_SUPERVISOR_ENABLED` | Enable the persistent generic supervisor |
| `HAWKSPAN_QUEUE_SUPERVISOR_POLL_INTERVAL_MS` | Maximum idle polling interval |
| `HAWKSPAN_QUEUE_WORKER_RESTART_DELAYS_MS` | Backoff after worker-process failure |
| `HAWKSPAN_QUEUE_ITEM_LEASE_MS` | Claim visibility/lease duration |
| `HAWKSPAN_QUEUE_MAX_ITEMS_PER_WORKER` | Maximum items processed per worker invocation |
| `HAWKSPAN_QUEUE_DEFAULT_MAXIMUM_ATTEMPTS` | Default terminal-failure threshold |
| `HAWKSPAN_QUEUE_DEFAULT_MAX_PENDING_ITEMS` | Default per-queue admission limit |
| `HAWKSPAN_QUEUE_DEFAULT_MAX_PAYLOAD_BYTES` | Default serialized payload limit |
| `HAWKSPAN_QUEUE_RETRY_JITTER` | Enable full jitter within configured retry delays |
| `HAWKSPAN_PACKAGE_RETURN_LOCK_WAIT_MS` | Maximum wait for the crash-released SQLite packet-return lock |
| `HAWKSPAN_SIMPLETUNER_STATE_LOCK_WAIT_MS` | Maximum wait for the crash-released SQLite scheduler-state lock shared by Node and Python |
| `HAWKSPAN_LINK_OPERATION_RETRY_DELAYS_MS` | Backoffs for same-route operation retries; HawkSpan stops primary retries early when needed to reserve a complete fallback attempt |
| `HAWKSPAN_LINK_OPERATION_ATTEMPT_TIMEOUT_MS` | Per-attempt bound that preserves time for later retries and fallback |
| `HAWKSPAN_LINK_CONNECT_TIMEOUT_MS` | Per-route connection timeout |
| `HAWKSPAN_LINK_CYCLE_TIMEOUT_MS` | Whole delivery-cycle timeout |
| `HAWKSPAN_LINK_SERVER_ALIVE_INTERVAL_SECONDS` | SSH keepalive interval |
| `HAWKSPAN_LINK_SERVER_ALIVE_COUNT_MAX` | Missed keepalives before failure |
| `HAWKSPAN_LINK_PRIMARY_REPROBE_MS` | Delay before retrying Thunderbolt after fallback |

Queue-specific `retry_delays_ms` and `maximum_attempts` override defaults.

## Application plugin extension

Use `examples/plugins/hello-world/` as the smallest source example and
`docs/PLUGIN-AUTHOR-GUIDE.md` for the manifest contract.

1. Create a package containing `hawkspan-plugin.json` and its module.
2. Give the operation a unique tool name and the narrow access origins it needs.
3. Validate/install with `node scripts/install-application-plugin.mjs /path/to/plugin`.
4. Restart the HawkSpan service if required by the plugin lifecycle.
5. Confirm the adapter using `list_queue_adapters`.
6. Create the queue with `adapter: "tool:<operation-name>"`.
7. Test the plugin and queue in isolated state before deploying it.

Keep queue mechanics generic. Implement application pause, resume,
checkpointing, cancellation, and reconciliation inside the application tool,
because those meanings differ by application.

All queue adapters execute in child processes. The supervisor remains responsive
and renews the fenced lease while an adapter runs. Each application tool must
still bound its own operation and report terminal success or failure so a hung
external application does not retain a renewable claim indefinitely.
