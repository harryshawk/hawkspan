Feature: Trustworthy source archive installation

  @automated @suite-release-tree
  Scenario: Verify an exact public source tree without Git metadata
    Given a published HawkSpan source archive with no Git worktree
    When the installer runs the release gate
    Then every public file matches the recorded release tree identifier
    And changed missing extra or symbolic-link entries fail closed

  @manual
  Scenario: Retain strict history provenance in a Git worktree
    Given HawkSpan is checked out as a Git worktree
    When the release gate runs
    Then the exact release tree and the complete Git history are both checked
