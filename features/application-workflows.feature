Feature: M2 controller coordinates a headless SimpleTuner worker
  HawkSpan preserves exact authorization, job binding, evidence, and asymmetry
  while keeping SimpleTuner control inert until explicitly configured.

  @automated @suite-simpletuner-examples
  Scenario: Ship reproducible public robot training examples
    Given the public HawkSpan robot example bundle is present
    Then it contains 20 LoRA images with seven reviewed caption alternatives each
    And it contains 20 matching ControlNet target and deterministic Canny conditioning pairs
    And both examples observe acceptance checkpoints 600 and 900
    And exact hashes, tokenizer limits, licenses, metadata, and private-data boundaries are verified
    And the examples are described as demonstrations rather than production-quality general models

  @automated @suite-application-workflows
  Scenario: Stage an exact captioned sample set idempotently
    Given a delivered sample set has an exact path, size, hash, count, and total-size manifest
    And a recorded job authorizes the dataset ID and exact manifest revision
    When the controller stages the sample set twice
    Then the first request creates the verified dataset
    And the second request reports no change
    And changed, additional, linked, missing-caption, or empty-caption files are rejected

  @automated @suite-application-workflows
  Scenario: Retain the full default checkpoint policy
    Given no SimpleTuner checkpoint milestone override is configured
    When HawkSpan reports the reviewed workflow defaults
    Then the product checkpoint milestones remain 600, 800, 900, 1000, and 1200
    And duplicate or invalid milestone values are rejected

  @automated @suite-application-workflows
  Scenario: Import a verified structured dataset bundle
    Given a HawkSpan artifact contains a bounded JSON bundle with exact hashes and caption sidecars
    When the worker imports that exact artifact into a named dataset
    Then every relative path, decoded byte count, file hash, manifest revision, and caption is verified
    And files are materialized only beneath the configured workload dataset root without shell or archive execution

  @automated @suite-application-workflows
  Scenario: Preserve worker-only asymmetry
    Given the plugin is requested on a controller role
    When an application workflow operation is requested
    Then HawkSpan denies the request before SimpleTuner is contacted

  @automated @suite-application-workflows
  Scenario: Package exact terminal trainer evidence
    Given an exact adapter-managed trainer record is terminal
    When HawkSpan builds its deterministic return packet
    Then a successful run requires one final LoRA and validation renders
    And a stopped or failed run requires at least one non-empty model checkpoint
    And a running trainer cannot be packaged
    And the verified packet is registered before artifact delivery remains a separate universal HawkSpan operation
