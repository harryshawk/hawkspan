Feature: Compatibility-preserving configuration controls

  @automated @suite-flags
  Scenario: Preserve symmetric behavior by default
    Given no compatibility flags are configured
    Then HawkSpan reports the symmetric role profile
    And established peer capabilities remain enabled

  @automated @suite-flags
  Scenario: Enforce an asymmetric controller and worker profile
    Given the controller-worker profile is selected
    And an explicit controller or worker node role is configured
    Then unspecified peer directions follow that role
    And explicit directional overrides take precedence

  @automated @suite-flags
  Scenario: Reject an invalid configuration atomically
    Given HawkSpan has unrelated installation configuration
    When an unknown flag, invalid type, or invalid tool name is submitted
    Then no part of the configuration is changed

  @automated @suite-flags
  Scenario: Restrict commands and command audit content
    Given authorized job enforcement is enabled
    When a command lacks recorded authorization
    Then HawkSpan rejects it
    And command content can be replaced by a digest in the audit

  @automated @suite-flags
  Scenario: Reject disabled inbound envelopes without state mutation
    Given inbound messages or acknowledgements are disabled
    When matching envelopes appear in the durable inbox
    Then HawkSpan records their rejection
    And does not import them or acknowledge correlated outbound messages

  @automated @suite-flags
  Scenario: Configure transport, background, artifact, wake, and adapter behavior
    Given the owner selects approved compatibility values
    Then HawkSpan validates and reports every effective value
    And a restart requirement is returned for service-wide changes

  @automated @suite-flags
  Scenario: Clear inherited symmetric overrides when selecting a node role
    Given symmetric directional defaults were previously explicit
    When the owner changes this Mac to a controller or worker
    Then inherited directional settings are cleared
    And an override submitted with the role change still takes precedence

  @automated @suite-flags
  Scenario: Enforce peer capability switches in both states
    Given a peer capability is enabled for outbound use
    Then the corresponding operation can reach peer transport
    When that capability is disabled
    Then HawkSpan rejects the operation before peer transport

  @automated @suite-flags
  Scenario: Distinguish routine and consequential command authorization
    Given only consequential commands require a recorded authorized job
    Then a routine command can run without that job
    And a consequential command without that job is rejected

  @automated @suite-flags
  Scenario: Select whether command text appears in audit history
    Given command-content auditing is disabled
    Then a digest is recorded instead of the command text
    When command-content auditing is enabled
    Then the executed command text is recorded

  @automated @suite-flags
  Scenario: Accept inbound acknowledgements only while enabled
    Given an outbound message is awaiting acknowledgement
    When inbound acknowledgements are disabled
    Then a matching envelope does not change the outbound message
    When inbound acknowledgements are enabled
    Then a matching envelope marks the outbound message acknowledged

  @automated @suite-flags
  Scenario: Apply background processing switches
    Given HawkSpan is running as its background service
    When background outbox processing is disabled
    Then a background flush is rejected
    When artifact sending or receiving is disabled
    Then that part of a permitted background flush is skipped

  @automated @suite-flags
  Scenario: Apply artifact verification modes
    Given a received artifact was already verified without metadata changes
    When on-change verification is selected
    Then HawkSpan may reuse that verified result
    Given a registered artifact changes without changing its size
    When cached verification is selected
    Then the recorded digest is trusted for outbound delivery
    When always verification is selected
    Then HawkSpan detects the changed source before transport

  @automated @suite-flags
  Scenario: Apply strict peer host identity modes
    Given peer transport uses an isolated SSH fixture
    When strict host identity is enabled
    Then SSH requires an existing pinned host key
    When strict host identity is disabled
    Then SSH accepts and records only a previously unseen key

  @automated @suite-flags
  Scenario: Select wake prompt disclosure
    Given a wake request contains a durable message body
    When embedded-message mode is selected
    Then the body is present in the peer wake command
    When notification mode is selected
    Then the body is absent from the peer wake command

  @automated @suite-flags
  Scenario: Enable or disable scoped application adapters at startup
    Given a valid application plugin fixture is configured
    When scoped operation adapters are enabled
    Then the validated plugin operations are loaded
    When scoped operation adapters are disabled
    Then no application plugin operations are loaded

  @automated @suite-flags
  Scenario: Enforce an exact inbound peer tool list at startup
    Given a peer-origin tool call uses an isolated service fixture
    When its tool is present in the inbound list
    Then the tool call is permitted
    When its tool is absent from the inbound list
    Then the tool call is rejected
