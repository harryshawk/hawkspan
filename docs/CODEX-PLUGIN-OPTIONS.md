# Running with or without the Codex plugin

HawkSpan supports two ways to operate the same code. The choice changes how a
user reaches HawkSpan; it does not create two implementations or two feature
sets.

## Without the Codex Personal plugin

Activate and start the HawkSpan release normally:

```sh
node scripts/activate-release.mjs --release-root "$PWD" --revision RELEASE_ID
node scripts/hawkspan-startup.mjs
node scripts/audit-release-authority.mjs
```

Use the local browser control surface or call an MCP tool from the command
line, for example:

```sh
node scripts/call-tool.mjs link_status '{}'
```

Advantages:

- no Codex plugin registration is required;
- background services, queues, recovery, transfers, and audits remain active
  independently of Codex;
- commands can be used by local scripts and other trusted automation;
- runtime upgrades do not depend on Codex discovering a new plugin cache.

Tradeoffs:

- HawkSpan tools and bundled skills do not automatically appear inside Codex;
- a user or agent must use the browser surface, command line, or another
  explicitly configured MCP client.

## With the Codex Personal plugin

First install and activate the same HawkSpan release. Then register that exact
release through the Codex Personal marketplace and install `hawkspan@personal`.
The detailed Personal plugin procedure and acceptance check are in
[INSTALL-M4.md](../INSTALL-M4.md).

Advantages:

- Codex automatically discovers the `hawkspan` MCP server from `.mcp.json`;
- HawkSpan tools appear as structured Codex tools with their existing schemas
  and authorization checks;
- bundled HawkSpan skills and operating guidance are available in new Codex
  tasks;
- agents can use the same audited HawkSpan operations without manually invoking
  `call-tool.mjs`.

Tradeoffs:

- the Personal plugin must be registered and installed for each Codex user and
  machine that should expose the tools;
- Codex must start a new task or restart after installation or upgrade;
- the installed plugin cache, active release authority, and running HawkSpan
  processes must identify the same release.

## What remains identical

The following do not change between modes:

- HawkSpan state under `~/.hawkspan`;
- release authority and fail-closed revision checks;
- SSH identity, peer authentication, and route selection;
- durable messages, jobs, queues, artifacts, and audit records;
- SimpleTuner controls and package return behavior;
- the MCP server implementation in `scripts/mcp-server.mjs`.

Installing the Codex plugin therefore adds a native Codex entry point; it does
not add a second remote-control architecture or a separate HawkSpan runtime.

## Terminology

The **Codex Personal plugin** registers HawkSpan itself with Codex. HawkSpan
**application plugins** are optional application-specific adapters managed by
HawkSpan. They are separate extension mechanisms and neither one is required
for HawkSpan's core standalone operation.
