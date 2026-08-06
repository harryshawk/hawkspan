Feature: HawkSpan-managed 100-step robot ControlNet LoRA lifecycle
  HawkSpan-D uses its hard-forked MCP server for control, identity,
  authorization, status, artifacts, and audit evidence.

  Background:
    Given M2 and M4 run the same immutable HawkSpan D revision
    And the M4 trainer is idle
    And the job owns a unique dataset, cache, output, and state namespace
    And its dataset contains 21 HawkSpan robot targets, 21 matching Canny controls, and 7 captions per target
    And every caption contains the trigger "hawkspan robots"
    And the recipe is bound to exactly 100 training steps

  Scenario: Reject an unauthorized start
    Given the durable training job is not authorized
    When M2 requests that M4 start the exact job through the HawkSpan-D MCP bridge
    Then M4 refuses to start it
    And no trainer process is active for the job

  Scenario: Authorize and start the exact revision
    Given the durable training job records the user's authorization
    And readiness binds the dataset, captions, controls, recipe, policy, and validation prompts
    When M2 requests that M4 start the bound revision
    Then M4 starts only that revision
    And status reports its job identity, revision fingerprint, PID, step, and state

  Scenario: Pause one running job without pausing the queue
    Given the authorized job is actively training
    When M2 requests a stop for that exact job
    Then M4 stops only the recorded process group
    And the job becomes stopped and ineligible to relaunch
    And the whole queue remains unpaused
    And completed checkpoints and caches remain present

  Scenario: Refuse resume after revision drift
    Given the stopped job has a recorded readiness fingerprint
    When an input bound by readiness changes
    Then M4 refuses to resume the job with the old fingerprint

  Scenario: Resume an unchanged stopped job
    Given the stopped job's bound inputs are unchanged
    And the user authorizes its resume
    When M2 makes the job eligible and starts the exact revision
    Then training resumes from the explicitly bound complete checkpoint
    And status continues to identify the same job

  Scenario: Complete, package, and return the 100-step result
    Given the resumed job reaches step 100 and exits successfully
    When the managed lifecycle enters packaging
    Then HawkSpan-D creates the exact job's return packet
    And M4 returns the registered packet through HawkSpan-D artifact delivery
    And M2 verifies the artifact identity, size, and SHA-256 digest
    And only the receipt-confirmed phase completes the SimpleTuner queue item

  Scenario: Automatically return every successful training package
    When an authorized training target exits zero with a valid final LoRA
    Then the same managed run builds the matching return packet
    And HawkSpan-D calculates and records the packet SHA-256 digest
    And HawkSpan-D durably sends the packet through its artifact queue
    And a periodic link cycle retries a queued return without duplicate registration

  Scenario: Never package an unsuccessful training target
    When training exits nonzero or is stopped before a valid final LoRA is complete
    Then no return packet is built or registered for that attempt

  Scenario: Evaluate the returned LoRA
    Given M2 has verified the returned packet
    When the fixed robot validation prompts are rendered with their mapped controls and seed
    Then the evaluation records the exact LoRA hash, prompts, controls, settings, and rendered files
    And results assess two robots, Hawk and Span nameplates, and their visible connecting span

  Scenario: Clear only test-owned transient state
    Given the returned packet and retained checkpoints have been verified
    When the user-authorized cleanup runs
    Then only this job's transient cache and disposable state are deleted
    And its source packet, output weights, checkpoints, return packet, and receipts remain present
