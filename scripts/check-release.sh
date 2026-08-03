#!/bin/zsh
set -euo pipefail

repo_root=${0:A:h:h}
cd "$repo_root"

if ! command -v rg >/dev/null 2>&1; then
  print -u2 "missing required release verifier dependency: rg (ripgrep)"
  exit 1
fi

node --check scripts/mcp-server.mjs
node --check scripts/call-tool.mjs
node --check scripts/start-local-control.mjs
node --check scripts/link-agent.mjs
node --check scripts/application-plugins.mjs
node --check scripts/local-control-surface.mjs
node --check scripts/hawkspan-env.mjs
node --check scripts/test-hawkspan-env.mjs
node --check scripts/install-application-plugin.mjs
node --check scripts/uninstall-application-plugin.mjs
node --check scripts/test-synthetic-plugins.mjs
node --check scripts/test-configuration-profiles.mjs
node --check scripts/test-connection-configuration.mjs
node --check scripts/test-local-control-help-videos.mjs
node --check scripts/test-agent-install-guide.mjs
node --check scripts/test-uninstall-hawkspan.mjs
node --check scripts/real-pair-acceptance-lib.mjs
node --check scripts/real-pair-acceptance.mjs
node --check scripts/test-real-pair-acceptance.mjs
node --check scripts/hawkspan-real-pair-adapter.mjs
node --check scripts/record-owner-assisted-fallback.mjs
node --check scripts/test-hawkspan-real-pair-adapter.mjs
node --check scripts/test-application-workflows.mjs
node --check scripts/test-simpletuner-example-bundle.mjs
node --check scripts/test-simpletuner-example-bundle-mutations.mjs
node --check examples/plugins/application-workflows/bin/hawkspan-packet-receiver.mjs
node --check scripts/test-application-workflows-packet-receiver.mjs
node --check scripts/release-tree.mjs
node --check scripts/check-release-tree.mjs
node --check scripts/test-release-tree.mjs
node --check scripts/test-first-run.mjs
node --check scripts/test-public-release-management.mjs
node scripts/test-mcp.mjs
node scripts/test-configuration-flags.mjs
node scripts/test-configuration-profiles.mjs
node scripts/test-connection-configuration.mjs
node scripts/test-hawkspan-env.mjs
node scripts/test-local-control-help-videos.mjs
node scripts/test-agent-install-guide.mjs
node scripts/test-uninstall-hawkspan.mjs
node scripts/test-real-pair-acceptance.mjs
node scripts/test-hawkspan-real-pair-adapter.mjs
node scripts/test-application-workflows.mjs
node scripts/test-simpletuner-example-bundle.mjs
node scripts/test-simpletuner-example-bundle-mutations.mjs
python3 scripts/test-application-workflows-trainer-control.py
python3 scripts/test-application-workflows-packet-builder.py
node scripts/test-application-workflows-packet-receiver.mjs
node scripts/test-release-tree.mjs
node scripts/test-first-run.mjs
node scripts/test-public-release-management.mjs
node scripts/test-faults.mjs
node scripts/test-application-plugins.mjs
node scripts/test-synthetic-plugins.mjs
node scripts/test-isolation.mjs
node scripts/test-acceptance.mjs
zsh -n scripts/install-link-agent.sh
zsh -n scripts/install-local-control-agent.sh
zsh -n scripts/uninstall-hawkspan.sh
zsh -n examples/plugins/application-workflows/bin/hawkspan-trainer-start.sh
zsh -n examples/plugins/application-workflows/bin/hawkspan-trainer-stop.sh
sh -n examples/plugins/application-workflows/bin/hawkspan-trainer-package.sh
plutil -lint launchd/org.hawkspan.link-agent.plist.template
node scripts/check-release-tree.mjs
git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -n $git_root && ${git_root:A} == ${repo_root:A} ]]; then
  zsh scripts/check-public-history.sh
else
  print "Git metadata absent: exact archive tree verified; history provenance must be established before archive publication"
fi
zsh scripts/test-public-history-scan.sh

real_env_files=$(find . \( -type f -o -type l \) \( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '*.env.*' \) \
  ! -name '*.env.example' -not -path './.git/*' -print)
if [[ -n $real_env_files ]]; then
  print -u2 "dotenv-family private files are forbidden in the release tree"
  print -u2 "$real_env_files"
  exit 1
fi

if [[ -n ${HAWKSPAN_PLUGIN_VALIDATOR:-} ]]; then
  python3 "$HAWKSPAN_PLUGIN_VALIDATOR" "$repo_root"
fi
if [[ -n ${HAWKSPAN_SKILL_VALIDATOR:-} ]]; then
  python3 "$HAWKSPAN_SKILL_VALIDATOR" "$repo_root/skills/hawkspan"
fi

privacy_pattern='/Users/har''ry|/Users/re''search|10\.44\.|019''f|twi''nk|al''ex|ad''ult|ejac''ulate|codex-mac-''link|com\.harry''hawk|\.codex-mac-''link'
if rg -n --hidden --glob '!**/.git/**' --glob '!scripts/check-release.sh' \
  --glob '!scripts/check-public-history.sh' -i "$privacy_pattern" .; then
  print -u2 "privacy scan failed"
  exit 1
fi

if rg -n --hidden --glob '!**/.git/**' \
  '(BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-)' \
  .; then
  print -u2 "secret-pattern scan failed"
  exit 1
fi

test -s LICENSE
rg -q 'MIT License' LICENSE
rg -q 'Not implemented' SECURITY.md
rg -q 'Thunderbolt' README.md
rg -q 'Ethernet' README.md
rg -q 'agent-to-agent' README.md
rg -q 'control of software' README.md

print "hawkspan release checks passed"
