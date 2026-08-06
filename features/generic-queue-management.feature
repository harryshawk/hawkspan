Feature: Durable generic queue management
  HawkSpan-D manages application work through durable generic queues without
  embedding application-specific scheduling behavior in the queue engine.

  Background:
    Given HawkSpan-D is running from one immutable installed revision
    And the queue registry uses its durable SQLite state
    And no alternate scheduler is running

  Scenario: Create a queue with an immutable identity
    When an operator creates a queue with a queue ID, kind, and adapter
    Then the queue is running with the requested policy
    And repeating the same creation request returns the existing queue
    And a conflicting kind or adapter is rejected

  Scenario: Configure a queue without replacing its identity
    Given an empty queue exists
    When its name, concurrency, priority, ordering, attempts, retry delays, or metadata changes
    Then the new policy is durable
    And its queue ID, kind, and adapter remain unchanged

  Scenario: Enqueue one item idempotently
    Given a running queue exists
    When the same item ID and payload are enqueued twice
    Then exactly one item exists
    And a different payload under that item ID is rejected

  Scenario: Enqueue a batch atomically
    Given a running queue exists
    When one item in a batch conflicts with durable state
    Then the whole batch is rejected
    And none of the new batch items are retained

  Scenario: Claim priority work in deterministic order
    Given a priority queue contains eligible items with different priorities
    When a worker claims the next item
    Then the lowest numeric priority is claimed first
    And creation order breaks equal-priority ties

  Scenario: Claim FIFO work in creation order
    Given a FIFO queue contains eligible items with different priorities
    When a worker claims the next item
    Then the earliest-created eligible item is claimed first

  Scenario: Enforce queue concurrency in the durable claim operation
    Given a queue has reached its configured running-item limit
    When another worker attempts to claim work
    Then no additional item is claimed
    And the response reports that the concurrency limit was reached

  Scenario: Pause and resume an entire queue
    Given a running queue contains eligible work
    When the operator pauses the queue
    Then workers cannot claim its items
    When the operator resumes the queue
    Then eligible items can be claimed again

  Scenario: Control a non-running item
    Given a queue contains a non-running item
    When the operator pauses, resumes, reprioritizes, skips, retries, or cancels that item
    Then only an allowed state transition succeeds
    And a retry clears its attempts and makes it eligible

  Scenario: Refuse control that would steal running work
    Given a worker owns a running item lease
    When another actor attempts a non-running item control on it
    Then the control is rejected
    And the worker retains its lease

  Scenario: Retry transient failure with bounded backoff
    Given a worker owns a running item
    When its adapter reports a transient failure before attempt exhaustion
    Then the item returns to queued state
    And its next attempt is delayed by the queue policy

  Scenario: Make exhausted work terminal
    Given an item has reached its maximum attempts
    When its adapter reports another failure
    Then the item becomes failed
    And it has no automatic next attempt

  Scenario: Repair attempts consumed by a confirmed software defect
    Given a queued, paused, or failed item has system-induced attempts
    When an operator resets that item's attempts with a reason
    Then its attempt count becomes zero without changing its payload or priority

  Scenario: Recover an expired worker lease
    Given a running item's worker lease has expired
    When another worker claims from the queue
    Then the expired item is returned to eligible work
    And its next execution is recorded as another attempt

  Scenario: Require lease ownership to finish work
    Given a worker owns a running item lease
    When a different worker tries to complete or fail it
    Then the operation is rejected

  Scenario: Clear pending work without deleting evidence
    Given a queue contains queued, paused, failed, running, and completed items
    When the operator clears pending work with a reason
    Then queued, paused, and failed items become cancelled
    And running and completed items remain unchanged
    And all item records remain available for audit

  Scenario: Archive a queue
    Given a queue is no longer accepting work
    When the operator archives it
    Then new items are rejected
    And existing item records remain available for audit

  Scenario: Delete only an empty queue
    Given a queue contains no item records
    When the operator deletes the queue
    Then the queue identity is removed
    But deletion is rejected for any queue that still has item records

  Scenario: Supervise queues through bounded workers
    Given running queues contain eligible work
    When the persistent supervisor starts queue workers
    Then it creates no more workers than each queue's concurrency
    And each worker processes no more than its configured item bound
    And worker restart attempts use the configured backoff delays

  Scenario: Preserve queue state across supervisor restart
    Given queue and item state is committed to SQLite
    When the supervisor or machine restarts
    Then the same queue identities and item states are loaded
    And expired running leases are recoverable

  Scenario: Provide authoritative HawkSpan queues on each host
    Given HawkSpan-D is freshly started on M2 and M4
    Then both hosts provide message and artifact queues
    And M4 provides exactly one durable SimpleTuner lifecycle queue
    And training, packaging, returning, and receipt confirmation are phases of one item
    And no jobs from another queue authority are migrated into those queues

  Scenario: Refuse duplicate SimpleTuner queues
    When an operator creates a generic queue using a SimpleTuner lifecycle tool
    Then HawkSpan-D rejects the queue
    And the established SimpleTuner scheduler remains the only lifecycle authority

  Scenario: Keep the built-in SimpleTuner queue immutable
    Given the built-in SimpleTuner lifecycle queue exists
    When an operator uses generic queue tools to rename, reconfigure, archive, clear, or delete it
    Then the generic registry cannot address that queue
    And the SimpleTuner queue identity and lifecycle adapter remain unchanged
