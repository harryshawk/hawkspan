# Requirements register

## Explicit product requirements

- R1: Preserve agent-to-agent coordination as a core mode.
- R2: Preserve one agent controlling software on the peer as a core mode.
- R3: Prefer Thunderbolt Bridge and fall back to private Ethernet.
- R4: State the same-owner, high-trust security posture candidly.
- R5: Distinguish implemented security from optional hardening.
- R6: Treat inference offload as a use case, not the product definition.
- R7: Retain durable messages, acknowledgements, jobs, wakeups, and verified
  artifacts.
- R8: Provide human-first and agent-first installation instructions.
- R9: Provide Gherkin/BDD acceptance behavior, regression tests, and layered
  parity, fault, security, and install/isolation checks.
- R10: Use MIT License as the working license.
- R11: Remove personal names, local paths, private addresses, hostnames, task
  IDs, private workload data and configuration, and operational fingerprints.
- R12: Preserve private-predecessor provenance without using the unauthorized clean-room
  output as code or architecture input.
- R13: Support generic optional application plugins without
  application-specific behavior in the core.
- R14: Preserve symmetric controller/worker behavior by default while allowing
  configuration to narrow node roles, origins, operations, and feature flags.
- R15: Enable the HTML client by default on `127.0.0.1` only, with a
  user-configurable local port and disable switch.
- R16: Keep namespace, state, service, SSH, install, and uninstall behavior
  isolated from other peer-link software.

## Release constraints

- Private predecessor originals remain untouched.
- The private baseline and evidence are not public-release artifacts.
- No public push occurs until history and tree privacy scans pass.
- Functional parity applies to the general coordination/control core. Sanitized
  application plugins may ship publicly; installation-specific values,
  credentials, datasets, models, state, and generated outputs do not.
