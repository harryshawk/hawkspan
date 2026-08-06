# Mac Link Hard-Fork Baseline

HawkSpan D is based on the recovery-patched
`codex-mac-link-recovery-patched-2026-08-04` source snapshot. Its deterministic
source-manifest SHA-256 is:

`9a781d5afa3883ef8b05d0de9095200dd1f2bfb9f7fa63d0d70ad3e7c14ed13e`

The predecessor private immutable source archive has SHA-256
`6817345a8e9f5b06f8ff69172621457298fbf92a7dece1d68176fdd17bb2eb96`.
That archive proves the pre-patch baseline only; the manifest above is the
authority for the recovery-patched source.

Private M2 and M4 configuration files are excluded from the baseline. They are
runtime configuration, not distributable implementation.

The parity ledger classifies every common file that intentionally differs.
Permitted classes are product naming and paths, removal of private values,
public generalization of training inputs, and the approved HawkSpan web,
package, preset, environment, ControlNet, documentation, and test additions.
The gate fails when a new common-file difference or product-only file appears.

Run the gate against the frozen local Mac Link source:

```sh
python3 scripts/check-hard-fork-parity.py \
  --mac-link-root /Users/localuser/plugins/codex-mac-link
```

The shared delegated-job and process-tree assertions remain inherited from Mac
Link. HawkSpan D extends the process-tree test only for its active LoRA runtime
pointer and release-upgrade process discovery. Both products run the same
validator cases: a 1,658-tensor LoHa, a conventional LoRA, an unrelated
safetensors model, and a malformed file. Product-specific test suites run
separately so HawkSpan-only functionality cannot redefine the Mac Link core.
