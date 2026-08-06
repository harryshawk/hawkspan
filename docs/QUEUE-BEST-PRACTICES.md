# Queue best-practice comparison

This comparison covers both HawkSpan's generic registry and the separate,
single SimpleTuner lifecycle queue. It does not treat packaging or artifact
transport as additional SimpleTuner queues.

## Verified behavior

| Practice | HawkSpan result | Evidence |
| --- | --- | --- |
| Durable local state | Pass | SQLite WAL, `synchronous=FULL`, foreign keys, and a 10-second busy timeout |
| Concurrent process startup | Pass | HawkSpan retries bounded `SQLITE_BUSY`/locked schema initialization |
| Atomic claim | Pass | `BEGIN IMMEDIATE` encloses lease recovery, selection, and state transition |
| Idempotent submission | Pass | Stable item ID plus identical payload returns the existing item; changed intent is rejected |
| Atomic batch insertion | Pass | Queue rows, message/artifact registrations, and audit records share one SQLite transaction; newly written message envelopes are removed on rollback |
| At-least-once recovery | Pass | Expired leases return work to the queue and increment the next claim's attempt count |
| Lease fencing and renewal | Pass | Every claim has a new generation token; stale tokens cannot settle reclaimed work; every adapter runs in a child process while the supervisor renews its live claim |
| Bounded jittered retries | Pass | Per-queue full-jitter retry schedule and maximum attempts end in inspectable `failed` state |
| Admission control | Pass | Each queue bounds pending item count and serialized payload bytes |
| Poison-item isolation | Partial | Exhausted items stop circulating, remain visible, and support manual redrive; there is no separate dead-letter queue |
| Ordering | Pass | Strict FIFO or stable priority/FIFO tie-breaking is selected per queue |
| Work isolation | Pass | Every item belongs to one queue; each queue owns concurrency, ordering, retries, and lifecycle |
| Operator controls | Pass | Queue pause/resume/archive/clear and item pause/resume/cancel/skip/retry/reprioritize are durable |
| Observability | Partial | Counts, attempts, lease generation/owner/expiry, next attempt, oldest pending age, result, error, and audit logs exist; aggregate rates and alarms do not |
| One SimpleTuner lifecycle | Pass | The scheduler retains one item through training, packaging, return, receipt confirmation, and completion; generic trainer queues are rejected |

Run the focused evidence with:

```sh
node scripts/test-queue-best-practices.mjs
node scripts/test-queue-registry.mjs
node scripts/test-queue-supervisor.mjs
```

## Delivery contract

HawkSpan is at-least-once. A timeout or expired lease can cause an adapter call
to be attempted again. Use stable item IDs and make application adapters
idempotent. The registry prevents duplicate queue records; it cannot make an
arbitrary shell command or third-party application operation idempotent.

## Out-of-scope scaling considerations

The research identifies the following capabilities for larger, higher-volume
systems. They are not HawkSpan requirements, release blockers, or reasons to
add queue architecture beyond the requested two-Mac workflows.

1. **Application-operation deadline:** child-process execution keeps lease
   renewal responsive, but an arbitrary registered tool can still hang unless
   that tool defines a bounded operation timeout and terminal failure behavior.
2. **Dedicated dead-letter routing:** exhausted work remains in terminal
   `failed` state in its source queue. This is inspectable and manually
   retryable, but lacks a separate quarantine/redrive queue.
3. **Global resource budget:** concurrency is bounded per queue, not across all
   queues. Many active queues can collectively overcommit a host.
4. **Retention and aggregate telemetry:** terminal records are intentionally
   preserved. There is no retention/purge policy, arrival/completion rate,
   oldest-item-age alarm, or saturation alarm.

These become relevant only if HawkSpan's operating scope later expands to many
queues, untrusted applications, or sustained production volume. They do not
invalidate or enlarge the requested HawkSpan workflows.

## Primary references

- Cary Gray and David Cheriton, *Leases: An Efficient Fault-Tolerant Mechanism
  for Distributed File Cache Consistency*:
  https://web.stanford.edu/class/cs240/readings/leases.pdf
- Pat Helland, *Life beyond Distributed Transactions: an Apostate's Opinion*:
  https://www.cidrdb.org/cidr2007/papers/cidr07p15.pdf
- Amazon Builders' Library, *Making retries safe with idempotent APIs*:
  https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
- Amazon Builders' Library, *Timeouts, retries, and backoff with jitter*:
  https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- Amazon Builders' Library, *Avoiding insurmountable queue backlogs*:
  https://d1.awsstatic.com/builderslibrary/pdfs/avoiding-insurmountable-queue-backlogs.pdf
- Amazon SQS, *Visibility timeout* and *Dead-letter queues*:
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
  and https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html
- SQLite, *Write-Ahead Logging*:
  https://sqlite.org/wal.html
- Mohan et al., *ARIES: A Transaction Recovery Method Supporting Fine-Granularity
  Locking and Partial Rollbacks Using Write-Ahead Logging*:
  https://www.cs.cmu.edu/~15849g/readings/mohan92.pdf
- Burrows, *The Chubby Lock Service for Loosely-Coupled Distributed Systems*:
  https://www.usenix.org/conference/osdi-06/chubby-lock-service-loosely-coupled-distributed-systems
- John D. C. Little, *A Proof for the Queuing Formula*:
  https://pubsonline.informs.org/doi/10.1287/opre.9.3.383
- OpenTelemetry, *Messaging semantic conventions*:
  https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
- Apple, *Designing for real-world networks*:
  https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/NetworkingOverview/WhyNetworkingIsHard/WhyNetworkingIsHard.html
