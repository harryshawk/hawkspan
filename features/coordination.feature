Feature: Durable peer-agent coordination

  @automated @suite-regression
  Scenario: Queue a message while the peer is unavailable
    Given a configured trusted peer with no reachable route
    When an agent sends a durable message
    Then the message keeps one immutable identity
    And its state remains queued for retry

  @automated @suite-regression
  Scenario: Acknowledge an inbound instruction
    Given an unacknowledged inbound message
    When the receiving agent acknowledges it
    Then an acknowledgement references the original message identity
    And the inbound record becomes acknowledged

  @automated @suite-regression
  Scenario: Deliver a verified artifact
    Given a registered local file with recorded size and SHA-256
    When HawkSpan sends it over an available route
    Then the peer stores a collision-safe artifact name
    And delivery succeeds only when the remote size and SHA-256 match
