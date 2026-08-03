Feature: Private machine settings outside Git
  HawkSpan keeps resolved installation values in a strict local environment file.

  @automated @suite-machine-env
  Scenario: Parse only reviewed machine settings
    Given a mode-600 HawkSpan environment file owned by the current user
    When HawkSpan loads machine settings once at startup
    Then only allowlisted names and typed values are accepted
    And duplicates symlinks unsafe modes oversized values and malformed types are rejected
    And quotes spaces dollar signs and shell-looking text remain literal data

  @automated @suite-machine-env
  Scenario: Keep resolved values out of diagnostics and child environments
    Given machine-specific peer values were loaded from hawkspan.env
    When diagnostics are exported or a child process is prepared
    Then resolved values are redacted from diagnostics
    And unrelated process environment values are not inherited

  @automated @suite-machine-env
  Scenario: Preserve the public and private configuration boundary
    Given role and capability settings are stored in public-shaped JSON
    And machine-specific values are stored in hawkspan.env
    When a profile is applied
    Then resolved machine values are not written into config.json
