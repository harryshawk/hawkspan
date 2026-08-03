Feature: Extensible application plugins
  HawkSpan can expose optional application integrations without embedding them
  in the coordination core.

  @automated @suite-plugin
  Scenario: Discover and validate a harmless plugin
    Given a plugin root containing a valid example and invalid candidates
    When HawkSpan starts using a temporary state home
    Then only the validated plugin operations are exposed
    And traversal and symbolic-link candidates are rejected

  @automated @suite-plugin
  Scenario: Treat operation input as data
    Given a validated plugin operation with a strict input schema
    When metacharacters and traversal-looking text are passed as a string
    Then the exact string is returned without shell interpretation
    And undeclared input fields are rejected

  @automated @suite-plugin
  Scenario: Validate richer operation schemas
    Given a plugin operation using bounded strings numbers arrays constants and nullable fields
    When values fall outside any declared boundary
    Then each invalid request is rejected before plugin code runs

  @automated @suite-plugin
  Scenario: Provide safe immutable entry configuration
    Given a plugin entry with bounded non-secret JSON configuration
    Then the plugin receives an immutable copy during activation
    And entries containing token secret or credential fields are rejected

  @automated @suite-plugin
  Scenario: Require one exactly authorized job
    Given a plugin operation requires a job ID kind and allowed state
    When the plugin checks that job through the narrow runtime helper
    Then missing mismatched and unrecorded authorizations are denied and audited

  @automated @suite-plugin
  Scenario: Filter durable plugin runs
    Given multiple durable plugin runs
    When status is filtered by run ID plugin operation or state
    Then only exact matches are returned within the existing status limit

  @automated @suite-plugin
  Scenario: Apply node roles and feature flags
    Given a worker-only node with an optional feature disabled
    When controller-only and flagged operations are requested
    Then both requests are denied
    And the symmetric controller-worker role set remains the default

  @automated @suite-plugin
  Scenario: Cancel and recover plugin work
    Given a durable long-running plugin operation
    When cancellation is requested
    Then the active operation observes cancellation
    And a run left active across restart is recorded as interrupted

  @automated @suite-regression
  Scenario: Preserve coordination and artifact compatibility
    Given the application plugin framework is present
    When core messaging jobs commands and artifact verification run
    Then their existing behavior still passes the regression suite

  @automated @suite-plugin
  Scenario: Install and uninstall in an isolated state home
    Given the public harmless example plugin
    When it is installed into a temporary HawkSpan home
    Then duplicate installation is rejected
    And uninstall archives only that plugin directory

  @automated @suite-plugin
  Scenario: Preview and confirm an installed application quick start
    Given a validated plugin declares a named application preset
    When the preset is previewed without confirmation
    Then no configuration is changed
    And the preview lists the exact approved restrictions and preserved categories

  @automated @suite-plugin
  Scenario: Apply only sanitized application preset settings
    Given private connection installation and plugin configuration values already exist
    When a reviewed application preset is applied with confirmation
    Then only role capability same-plugin peer-tool and enabled-operation settings change
    And connections credentials paths tokens local control other plugins and application data are preserved

  @automated @suite-plugin
  Scenario: Reset an application quick start safely
    Given an installed application preset has been applied
    When its reset is explicitly confirmed
    Then role and capability overrides return to inherited defaults
    And only that plugin's enabled-operation restriction is removed

Feature: Optional local control surface
  The browser surface is an alternate local client of the same service tools.

  @automated @suite-plugin
  Scenario: Keep the default HTML surface strictly local
    Given a default HawkSpan configuration
    Then the HTML listener binds to 127.0.0.1
    And a user can disable it or select a different local port
    When a non-loopback bind configuration is supplied
    Then the configuration is rejected

  @automated @suite-plugin
  Scenario: Enforce local HTML authorization
    Given the local control surface has a narrow tool allowlist
    When a token-authenticated plugin call is made
    Then it uses the same plugin handler as MCP
    And a tool outside the allowlist is denied

Feature: Service coexistence
  HawkSpan remains isolated from other peer-link software.

  @automated @suite-isolation
  Scenario: Keep HawkSpan namespaces self-contained
    Given the public repository configuration
    Then state defaults remain under the HawkSpan namespace
    And the background service label remains in the HawkSpan namespace
    And no test connects to or changes an installed peer-link service
