Feature: Recoverable HawkSpan core removal
  HawkSpan can be removed without deleting its configuration or coordination state.

  @automated @suite-uninstall
  Scenario: Preview removal without changing the installation
    Given HawkSpan core state and its two user launch services
    When the core uninstaller runs without explicit confirmation
    Then it reports the exact HawkSpan-owned files and services it would change
    And it does not stop a service or move a file

  @automated @suite-uninstall
  Scenario: Archive a confirmed core installation
    Given HawkSpan core state and its two user launch services
    When the core uninstaller runs with explicit confirmation
    Then it stops only the two HawkSpan core service labels
    And it moves the state and launch plists into a timestamped archive
    And the archive contains restoration instructions

