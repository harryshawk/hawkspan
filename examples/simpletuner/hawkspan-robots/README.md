# HawkSpan robot training examples

This public bundle is a reproducible, G-rated acceptance and demonstration
set for HawkSpan's bundled `application-workflows` SimpleTuner adapter. It is
not a production-quality general model dataset.

The bundle provides two independent examples:

- `lora/` is the public release and Draw Things acceptance workload. It trains
  a conventional SDXL LoRA from 20 source JPGs and 20 seven-line caption
  sidecars. SimpleTuner selects one line as a caption alternative because the
  backend keeps `disable_multiline_split` set to `false`.
- `controlnet/` is a separate trainer demonstration. With SimpleTuner 4.5 it
  trains an SDXL ControlNet PEFT LoHa adapter from 20 byte-identical target JPGs
  paired with 20 deterministic RGB Canny PNGs. Matching basenames define each
  pair. Both directories include the same reviewed caption sidecars. This
  adapter is not the conventional LoRA used by the Draw Things acceptance gate.

Both examples are configured to observe acceptance checkpoints 600 and 900.
Their recipes use SimpleTuner's canonical `checkpoint_step_interval` and
`validation_step_interval` keys. Legacy aliases must not be supplied alongside
the canonical keys, even with equal values, because ambiguous configuration
fails the public validator closed.
The source images, captions, review PDF, and related documentation assets are
licensed under CC BY 4.0; see `ASSET-LICENSE.md`. HawkSpan code remains under
MIT.

## Safe use

Do not train in the repository. Copy one example to owner-only local workload
state, render every angle-bracket placeholder there, and store generated
configs, caches, checkpoints, models, receipts, and outputs outside the clone.
Machine addresses, usernames, SSH material, tokens, and absolute installation
paths belong only in `~/.hawkspan/hawkspan.env` or other owner-only state.

An agent or human should:

1. Run `node scripts/test-simpletuner-example-bundle.mjs` from the HawkSpan
   root and review this bundle's license and manifests.
2. Prepare SimpleTuner using `docs/SIMPLETUNER-SETUP.md`, then install and
   configure `examples/plugins/application-workflows` using
   `docs/APPLICATION-WORKFLOWS-PLUGIN.md`.
3. Copy `lora/` for the release/Draw Things acceptance run, or copy
   `controlnet/` only for the separate ControlNet trainer demonstration.
4. Replace placeholders in the copied backend and recipe files with reviewed
   local paths and an installed base-model revision. Preserve the fixed run ID
   and output basename.
5. Save the exact recipe beneath the configured worker recipe root and
   calculate its SHA-256 before staging the immutable runtime.
6. Use the local trainer path described in the workflow guide. Only after
   explicit authorization, use HawkSpan to transfer/import the dataset, stage
   the immutable runtime, start and monitor the bound run, observe checkpoints
   600 and 900, build the complete packet, deliver it, and verify its receipt.

The example worker policies enable only the local operations needed for that
authorized workflow. HTTP queue submission and manual checkpoint creation are
not part of the workflow.
Both policies retain a 30-second start/stop timeout and assign packet packaging
its separate one-hour timeout. A peer package call must request a matching
timeout; the supported end-to-end maximum is four hours.
The examples neither authorize nor launch training by themselves.

## Contents and validation

- `lora/manifest.json` records all 20 source-image and caption hashes.
- `controlnet/manifest.json` records all 20 target/control pairs and hashes.
- `controlnet/compat/simpletuner-4.5-controlnet-pixels.patch` is the bounded
  compatibility correction required when an installed SimpleTuner 4.5.x
  collator recognizes ControlNet pairs but returns no conditioning pixels.
  Preserve the original installed file, apply the patch from the SimpleTuner
  package root, and include both the patch and installed version in the return
  packet. Do not apply it when the installed collator already collects pixels
  for `StateTracker.get_args().controlnet`.
  The application plugin carries a byte-identical installed copy for packaging
  the worker environment evidence.
- `controlnet/compat/simpletuner-4.5-sdxl-controlnet-validation.patch` handles
  SimpleTuner 4.5.x's copied SDXL ControlNet pipeline when its FlowMap UNet
  omits the optional `time_cond_proj_dim` setting. Apply and preserve it only
  when startup validation fails on `do_classifier_free_guidance` for that
  reason. The plugin also carries a byte-identical packet-evidence copy.
- `caption-tokenizer-validation.json` is the recorded offline validation for
  the exact declared SDXL model revision and both tokenizers. It binds all 140
  rows to the caption corpus hash and records the observed 42-token maximum,
  below the 77-token ceiling. Normal CI validates that exact receipt and its
  corpus binding; it does not download or rerun the model tokenizers.
- `review/HawkSpan-Robot-Caption-Review.md` is the canonical readable review,
  deterministically reconstructed from all 20 sidecars and compared
  byte-for-byte by the validator.
- `review/HawkSpan-Robot-Caption-Review-Text-Only.pdf` is a convenience copy for
  people. CI does not parse its content; `review/review-receipt.json` binds its
  exact SHA-256 to the same caption-corpus revision and canonical-review hash.
  Obsolete image-heavy review files are excluded.
- `node scripts/test-simpletuner-example-bundle.mjs` checks counts, names,
  hashes, dimensions, caption structure, uniqueness, tokenizer receipt,
  canonical review/PDF bindings, ControlNet pairing/configuration, checkpoint
  retention and validation cadence, metadata filenames, symlinks, and
  private-data patterns. Its companion mutation test proves those checks fail
  closed when deliberately corrupted.

Rebuilding the Canny controls is optional and requires OpenCV for Python:

```sh
python3 examples/simpletuner/hawkspan-robots/controlnet/tools/generate_canny.py
node scripts/test-simpletuner-example-bundle.mjs
```
