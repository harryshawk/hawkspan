# Install HawkSpan-D on the M4

> This installs normal HawkSpan. For an isolated M4-to-Grok HGS peer, use
> [`docs/INSTALL-HGS-SECOND-CODEX.md`](docs/INSTALL-HGS-SECOND-CODEX.md).

This installation must not interrupt an active SimpleTuner process.

## 1. Install the M2 public key

Download:

`http://198.51.100.10:8044/M2-to-M4/bootstrap/hawkspan_peer.pub`

Append that public key once to:

`/Users/workeruser/.ssh/authorized_keys`

Set:

```sh
chmod 700 /Users/workeruser/.ssh
chmod 600 /Users/workeruser/.ssh/authorized_keys
```

Never transmit either Mac's private key.

## 2. Configure Thunderbolt

- M4 Thunderbolt Bridge: `192.0.2.11`
- subnet: `255.255.255.0`
- no router
- no DNS
- keep Wi-Fi as the default internet route

Verify:

```sh
ping -c 3 192.0.2.10
ssh -i /Users/workeruser/.ssh/hawkspan_peer \
  -o BatchMode=yes controlleruser@192.0.2.10 true
```

## 3. Install the plugin source

Use the plugin-creator scaffold on the M4 first so its personal marketplace
entry is created correctly:

```sh
cd /Users/workeruser/.codex/skills/.system/plugin-creator
python3 scripts/create_basic_plugin.py hawkspan \
  --with-skills --with-scripts --with-mcp --with-marketplace --force
```

Then replace the generated plugin directory with the complete
`hawkspan-plugin.zip` contents at:

`/Users/workeruser/plugins/hawkspan`

Install the M4 configuration:

```sh
mkdir -p /Users/workeruser/.hawkspan
cp /Users/workeruser/plugins/hawkspan/config/m4-config.example.json \
  /Users/workeruser/.hawkspan/config.json
chmod 600 /Users/workeruser/.hawkspan/config.json
```

## 4. Validate and install

```sh
cd /Users/workeruser/.codex/skills/.system/plugin-creator
python3 scripts/validate_plugin.py /Users/workeruser/plugins/hawkspan
python3 scripts/read_marketplace_name.py
```

Use the returned marketplace name:

```sh
codex plugin add hawkspan@personal
```

If the marketplace name is not `personal`, substitute the value returned by
`read_marketplace_name.py`.

Restart or resume the M4 Codex task after installation so the MCP tools are
loaded. Preserve the existing M4 compatibility edits only if they are newer
than the shared build.

## 5. Acceptance test

From a new M4 task with the plugin:

1. Call `link_status`.
2. Call `trainer_status`.
3. Call `trainer_queue_status` and validate one captioned dataset.
4. Send a message to `m2-codex`.
5. Confirm M2 acknowledgement.
6. Register and transfer a small non-sensitive test artifact.
7. Confirm the M2 verifies it.
8. Test fallback with an unreachable-primary test configuration; do not
   disconnect a healthy training machine.

Do not start, stop, or alter training during this acceptance test.
