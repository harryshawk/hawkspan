Feature: Synthetic application-plugin test point
  HawkSpan can prove generic application control without embedding an
  application-specific integration in its core.

  @automated @suite-synthetic
  Scenario: Render and draw through worker-only peer plugins
    Given the SyntheticRender and SyntheticDraw example plugins are installed on a worker
    When a peer invokes both plugins with schema-valid inputs
    Then each operation returns a registered SVG artifact
    And local and controller-only execution remain unavailable
