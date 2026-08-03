# SimpleTuner worker setup

This guide prepares an Apple-silicon Mac as the optional HawkSpan SimpleTuner
worker. HawkSpan does not install or modify SimpleTuner automatically. Keep the
trainer, models, caches, datasets, and outputs outside the HawkSpan repository.

The release acceptance environment uses arm64 Python 3.12, SimpleTuner 4.5.0,
PyTorch with MPS built and available, and the two reviewed compatibility patches
bundled with the application-workflows plugin. Other SimpleTuner 4.5.x patch
releases must pass the same checks before use.

## Install the worker environment

Create a dedicated directory and virtual environment. The resulting
interpreter must be native arm64 Python 3.12.

```sh
mkdir -p ~/Applications/SimpleTuner
cd ~/Applications/SimpleTuner
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install 'simpletuner[apple]==4.5.0'
```

Confirm the installed distribution and MPS backend:

```sh
.venv/bin/python - <<'PY'
import importlib.metadata
import platform
import torch

print("simpletuner", importlib.metadata.version("simpletuner"))
print("python machine", platform.machine())
print("torch", torch.__version__)
print("MPS built", torch.backends.mps.is_built())
print("MPS available", torch.backends.mps.is_available())
PY
```

Do not continue unless the machine is `arm64`, SimpleTuner is `4.5.x`, and both
MPS values are `True`.

## Apply the bounded ControlNet corrections

The public robot ControlNet acceptance run exposed two SimpleTuner 4.5.0
defects. Preserve the original installed files, then dry-run and apply the
reviewed patches from the virtual environment's `site-packages` directory:

```sh
site=$(.venv/bin/python -c 'import site; print(site.getsitepackages()[0])')
cp "$site/simpletuner/helpers/training/collate.py" \
  "$site/simpletuner/helpers/training/collate.py.before-hawkspan"
cp "$site/simpletuner/helpers/models/sdxl/pipeline.py" \
  "$site/simpletuner/helpers/models/sdxl/pipeline.py.before-hawkspan"
patch -d "$site" -p1 --dry-run < \
  /path/to/hawkspan/examples/plugins/application-workflows/bin/compat/simpletuner-4.5-controlnet-pixels.patch
patch -d "$site" -p1 < \
  /path/to/hawkspan/examples/plugins/application-workflows/bin/compat/simpletuner-4.5-controlnet-pixels.patch
patch -d "$site" -p1 --dry-run < \
  /path/to/hawkspan/examples/plugins/application-workflows/bin/compat/simpletuner-4.5-sdxl-controlnet-validation.patch
patch -d "$site" -p1 < \
  /path/to/hawkspan/examples/plugins/application-workflows/bin/compat/simpletuner-4.5-sdxl-controlnet-validation.patch
```

If either dry run fails, stop. The installed source differs from the reviewed
4.5.0 contract and must not be patched by guessing. Packet construction records
the installed version and corrected source hashes.

## HawkSpan execution path

The bundled robot acceptance run uses the local trainer path. HawkSpan
stages one immutable runtime job and invokes only
`<SimpleTuner root>/.venv/bin/simpletuner train`.

## Configure HawkSpan

Create the workload directories named in `config/hawkspan.env.example`. Set
`HAWKSPAN_SIMPLETUNER_ROOT` to the directory containing `.venv`, and set the
three local trainer script variables to the installed application-workflows
plugin's reviewed scripts. Keep `hawkspan.env` at mode `600`.

From the HawkSpan repository, install the reviewed bundled plugin:

```sh
node scripts/install-application-plugin.mjs examples/plugins/application-workflows
```

Then copy the complete object from
`examples/plugins/application-workflows/config.example.json` into:

```text
application_plugins.entries.application-workflows.configuration
```

On the worker, keep both the global ceiling and this exact plugin's core-tool
allowlist restricted to the two artifact operations used while packaging a
return packet:

```json
"application_plugins": {
  "core_tool_allowlist": [
    "verify_artifact",
    "register_artifact"
  ],
  "entries": {
    "application-workflows": {
      "core_tool_allowlist": [
        "verify_artifact",
        "register_artifact"
      ]
    }
  }
}
```

On the controller, the separately enabled local-only
`training_receive_return_packet` operation instead requires exactly
`receive_artifacts`, `verify_artifact`, and `send_message` in both allowlists.
Set its plugin configuration role to `controller`, point its `state_root` at
HawkSpan's own state root, and enable only `packet_intake` plus the
`workload-packet-intake` application-plugin feature flag. Do not add those
controller permissions to the worker.

This allowlist does not grant command execution or bypass the workflow's
revision-bound job authorization. Do not add broader core tools for this
workflow. The public example remains empty by default; add these exact entries
only when enabling this reviewed workflow.

Packet delivery remains a separate universal HawkSpan `send_artifact` call. It
is not granted to the application plugin.

Set that entry's `enabled` value to `true`, restrict its origins and operations,
and enable `inspect` first. The worker quick-start preset deliberately does not
copy paths, endpoints, credentials, or plugin configuration.

Run `training_local_process_status` and
`training_validate_local_dataset` before enabling staging or trainer control.
Then follow `APPLICATION-WORKFLOWS-PLUGIN.md` and the robot example README for
revision-bound staging, authorization, start, monitoring, packaging, delivery,
and receipt.

## Diagnostics

Use `training_tail_local_log` for bounded trainer logs. Core launch services
write local diagnostics beneath `~/.hawkspan/audit/`; inspect
`link-agent-error.log` or `local-control-error.log` after any service startup
failure. Never include those local logs in a public issue without redacting
machine settings and paths.
