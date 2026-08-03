Feature: Privacy-safe acceptance on a real HawkSpan pair

  The public harness records only fixed pass or fail assertions. It never records
  usernames, hostnames, addresses, personal paths, task IDs, message bodies,
  commands, workload data, machine environment values, or adapter errors.

  @automated @suite-real-pair-harness
  Scenario: Keep real-pair acceptance inert until explicitly authorized
    Given the real-pair runner has no execution authorization
    When it runs with its default options
    Then it emits a preflight plan without loading an adapter
    And fake-adapter tests prove receipts exclude machine-specific runtime values

  @automated @suite-real-pair-harness
  Scenario: Isolate machine configuration from public adapter code
    Given an agent-managed HawkSpan environment file with mode 600
    When the authorized runner parses it as strict allowlisted data
    Then it passes a private config object to a child adapter with a minimal environment
    And it rejects symlinks unsafe ownership permissions unknown or duplicate keys and malformed types
    And it treats quotes spaces dollar signs and shell-looking text as literal values

  @automated @suite-real-pair-adapter
  Scenario: Derive every public adapter assertion from observed results
    Given deterministic fake HawkSpan interfaces for all twelve checks
    When the public adapter evaluates their structured results
    Then every assertion passes only when its required observation is present
    And malformed owner fallback evidence and malformed local process evidence fail closed

  @real-pair @manual
  Scenario: Validate each enabled route independently
    Given an owner-authorized pair with two enabled routes
    When the real-pair adapter tests each route by itself
    Then the receipt records only whether primary and fallback passed

  @real-pair @manual
  Scenario: Validate primary preference and owner-assisted fallback
    Given both routes pass independently
    When normal traffic is sent
    Then the configured primary route is selected
    When the owner temporarily interrupts the primary route
    Then the fallback route is selected
    And the owner restores the primary route

  @real-pair @manual
  Scenario: Exercise MCP list and call
    Given real HawkSpan MCP is available
    When the adapter lists tools and calls an approved harmless tool
    Then both operations pass without their payloads entering the receipt

  @real-pair @manual
  Scenario: Correlate a received message and acknowledgement
    Given a synthetic acceptance message is sent between the peers
    When the receiver imports and acknowledges it
    Then the sender observes an acknowledgement correlated to that message
    And no message identity or body enters the receipt

  @real-pair @manual
  Scenario: Complete a remote job lifecycle
    Given a synthetic acceptance job is created
    When it moves through authorized running and completed states
    Then the receipt records only that every lifecycle state was observed

  @real-pair @manual
  Scenario: Verify small artifacts in both directions
    Given the runner supplies two small public fixture payloads
    When each peer sends one fixture to the other
    Then both received files match their registered SHA-256
    And no digest path artifact identity or content enters the receipt

  @real-pair @manual
  Scenario: Enforce asymmetric controller and worker roles
    Given one peer is the controller and the other is the worker
    When an approved controller-to-worker operation is attempted
    Then it succeeds
    When the corresponding worker-to-controller operation is attempted
    Then it is denied

  @real-pair @manual
  Scenario: Verify installed services and local HTML
    Given the foreground checks passed before service installation
    When the HawkSpan services are inspected
    Then the link service and local-control service are ready
    And the HTML control surface is reachable only through loopback

  @real-pair @manual
  Scenario: Verify coexistence and rollback readiness
    Given HawkSpan is installed beside another peer-link product
    When HawkSpan namespaces and rollback evidence are inspected
    Then only HawkSpan-owned namespaces are used
    And no other product is inspected or changed
    And the installed exact release ID state preservation and restore instructions are ready

  @real-pair @manual
  Scenario: Inspect SimpleTuner without changing training state
    Given the reviewed SimpleTuner plugin is installed on the worker
    When the adapter calls the read-only local process inspection operation
    Then the configured local trainer root and process result are validated without claiming installation or version proof
    And no training queue operation is called
