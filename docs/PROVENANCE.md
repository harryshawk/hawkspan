# Provenance

HawkSpan is one public product built as a sanitized hard fork of a working
internal predecessor. A sealed predecessor import shares the public fork's
initial lineage but must remain outside the public repository because it
contains installation details and unsanitized local workload material.

The public release process must rewrite or replace the private ancestry so no
unsanitized blob, path, commit message, tag, reflog, or Git object is pushed.
The private evidence manifest and baseline commit ID may be retained outside
the public repository to demonstrate lineage.

No code, design, tests, or architecture were taken from the unauthorized
clean-room HawkSpan output.

## SimpleTuner compatibility

The optional local workflow targets SimpleTuner 4.5.x and invokes only the
installed `.venv/bin/simpletuner train` command through the reviewed local
trainer controller. HawkSpan ships bounded compatibility patches as evidence;
it does not copy SimpleTuner source code.

## Robot example assets

The 20 source JPGs under `examples/simpletuner/hawkspan-robots/` were generated
at the project owner's direction using GPT Image 2 for public redistribution
as a HawkSpan acceptance/demo set. The seven-line captions were written and
visually reviewed for those exact images. The ControlNet target JPGs and
caption sidecars are byte-identical copies; the paired conditioning PNGs were
deterministically derived with OpenCV 4.9.0 Canny processing using grayscale
conversion, thresholds 100 and 200, and PNG compression level 9. The example
manifests bind every asset to its SHA-256 hash.

The caption tokenizer receipt records an offline check against both SDXL base
1.0 tokenizers at revision
`462165984030d82259a11f4367a4eed129e94a7b`; all 140 caption alternatives were
within the 77-token ceiling, with a maximum of 42 tokens. Automated release
checks validate the exact receipt structure and caption-corpus binding without
claiming to download or rerun either tokenizer. The canonical Markdown review
is reconstructed from the sidecars byte-for-byte; the convenience PDF is not
content-parsed in CI and is instead bound by SHA-256 to that caption revision.
See the example's `ASSET-LICENSE.md` for CC BY 4.0 terms. No base model,
trained weights, cache, runtime state, or generated training output is included.
