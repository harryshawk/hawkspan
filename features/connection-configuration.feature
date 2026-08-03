Feature: Configurable peer connections

  @automated @suite-connections
  Scenario: Preserve established legacy route availability
    Given a legacy configuration has route hosts without enable flags
    When the connection configuration is read
    Then only routes with configured hosts are enabled
    And automatic fallback is enabled only when both hosts exist

  @automated @suite-connections
  Scenario: Operate with only one configured route
    Given primary and fallback connections are configured
    When one connection is explicitly disabled
    Then the disabled connection is not probed or selected
    And its status is disabled rather than failed
    And the enabled connection remains available without automatic fallback

  @automated @suite-connections
  Scenario: Reject an unusable connection configuration
    Given connection changes require explicit confirmation
    When both routes are disabled or an enabled route has no host
    Then the update is rejected atomically
    And unrelated configuration remains unchanged

  @automated @suite-connections
  Scenario: Keep network settings outside capability profiles
    Given custom connection labels, hosts, and enablement are active
    When a capability profile is saved, applied, or reset
    Then the profile contains no network settings
    And the active connection settings are preserved
