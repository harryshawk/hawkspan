Feature: Safe reusable configuration profiles

  @automated @suite-profiles
  Scenario: Confirm a reset while preserving unrelated installation settings
    Given HawkSpan has role and feature overrides plus peer and plugin settings
    When a reset is requested without explicit confirmation
    Then no configuration is changed
    When the reset is explicitly confirmed
    Then only role and approved feature overrides are removed
    And inherited symmetric defaults become effective

  @automated @suite-profiles
  Scenario: Save only approved settings in a named profile
    Given HawkSpan has private peer, identity, path, plugin, and local-control settings
    When the current settings are saved under a human-readable name
    Then the profile receives a generated path-safe identifier
    And none of the unrelated or private settings enter the profile
    And replacement requires explicit confirmation

  @automated @suite-profiles
  Scenario: Apply and delete a user profile safely
    Given a named configuration profile exists
    When applying or deleting it without explicit confirmation
    Then the operation is rejected without changing state
    When applying it is explicitly confirmed
    Then only approved configuration keys change atomically
    And HawkSpan reports that a restart is required

  @automated @suite-profiles
  Scenario: Offer immutable use-case presets
    Given HawkSpan supplies symmetric, high-value controller, compute worker, and coordination-only presets
    Then each preset explains its source and impact
    And its command, coordination, artifact, and host-checking effects match its use case
    And a built-in preset cannot be replaced or deleted
