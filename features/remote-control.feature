Feature: Audited peer software control

  @automated @suite-faults
  Scenario: Invoke an allowed tool on the peer
    Given the preferred route is transport-ready
    When an agent invokes an allowlisted peer tool
    Then HawkSpan uses the preferred route
    And records the peer call in the audit trail

  @automated @suite-faults
  Scenario: Fall back from Thunderbolt to Ethernet
    Given the configured Thunderbolt route is unavailable
    And the configured Ethernet route is transport-ready
    When an agent invokes an allowlisted peer tool
    Then HawkSpan uses the Ethernet route

  @automated @suite-regression
  Scenario: Execute an authorized peer command
    Given the active user instruction authorizes a software-control action
    When the agent calls run_command on the peer
    Then HawkSpan records command timing and exit state
    And returns bounded standard output and error
