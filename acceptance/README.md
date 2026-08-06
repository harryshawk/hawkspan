# HawkSpan D Real Acceptance Evidence

This directory records evidence from the real M2/M4 acceptance gate for the
installed HawkSpan D public candidate. Synthetic tests are supporting evidence
only and do not satisfy the scenarios tracked here.

All cross-machine test actions must use HawkSpan D's installed `call-tool.mjs`
or its `peer_call_tool`. HawkSpan-D background services remain idle throughout
the gate so they cannot supply the behavior under test.
