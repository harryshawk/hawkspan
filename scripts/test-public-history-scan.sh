#!/bin/zsh
set -euo pipefail

repo_root=${0:A:h:h}
scanner="$repo_root/scripts/check-public-history.sh"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/hawkspan-privacy-mutations.XXXXXX")
trap 'rm -rf -- "$tmp_dir"' EXIT

# Git object IDs are random hex and must never be scanned as path text. A hash
# can coincidentally contain a blocked token even when its path is safe.
if rg -q 'scan_file "reachable path [^"]+" "\$tmp_dir/reachable-objects"' "$scanner"; then
  print -u2 "privacy scanner incorrectly scans Git object IDs as path text"
  exit 1
fi

initialize_case() {
  local case_dir=$1
  mkdir -p "$case_dir"
  git -C "$case_dir" init -q
  print -r -- 'synthetic release-gate fixture' > "$case_dir/README.md"
  git -C "$case_dir" add README.md
  git -C "$case_dir" -c user.name='Release Gate Test' \
    -c user.email='release-gate@invalid.example' commit -q -m 'safe scanner baseline'
}

assert_rejected() {
  local label=$1
  local planted_value=$2
  local case_dir="$tmp_dir/$label"

  initialize_case "$case_dir"
  print -r -- "$planted_value" > "$case_dir/planted-leak.txt"
  git -C "$case_dir" add planted-leak.txt
  git -C "$case_dir" -c user.name='Release Gate Test' \
    -c user.email='release-gate@invalid.example' commit -q -m 'scanner mutation fixture'

  if HAWKSPAN_SCAN_ROOT="$case_dir" zsh "$scanner" >/dev/null 2>&1; then
    print -u2 "privacy scanner failed to reject: $label"
    return 1
  fi
}

# Values are assembled so the test source itself does not contain a complete
# private-data specimen. Each committed mutation must independently fail.
assert_rejected personal_user_path "/""Users/har""ryhawk/private/config.json"
assert_rejected private_ip "10.""44.45.3"
assert_rejected email_address "private.owner""@company.test"
assert_rejected task_identifier "019""fa06b-af10-7431-a6fd-8e37e49466b5"
assert_rejected github_token "ghp_""abcdefghijklmnopqrstuvwxyz123456"
assert_rejected ssh_public_key "ssh-ed25519 ""QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo5ODc2NTQzMjE="

for dotenv_name in .env .env.local .env.production .env.backup machine.env hawkspan.env.local; do
  env_case="$tmp_dir/dotenv-${dotenv_name//[^A-Za-z0-9]/-}"
  initialize_case "$env_case"
  print -r -- 'HAWKSPAN_NODE_ID=private-fixture' > "$env_case/$dotenv_name"
  git -C "$env_case" add -f "$dotenv_name"
  git -C "$env_case" -c user.name='Release Gate Test' \
    -c user.email='release-gate@invalid.example' commit -q -m 'environment path fixture'
  if HAWKSPAN_SCAN_ROOT="$env_case" zsh "$scanner" >/dev/null 2>&1; then
    print -u2 "privacy scanner failed to reject: $dotenv_name"
    exit 1
  fi
done

ignore_case="$tmp_dir/ignore-policy"
initialize_case "$ignore_case"
cp "$repo_root/.gitignore" "$ignore_case/.gitignore"
git -C "$ignore_case" add .gitignore
git -C "$ignore_case" -c user.name='Release Gate Test' \
  -c user.email='release-gate@invalid.example' commit -q -m 'public ignore policy fixture'
for dotenv_name in .env .env.local .env.production .env.backup machine.env hawkspan.env.local; do
  if ! git -C "$ignore_case" check-ignore -q "$dotenv_name"; then
    print -u2 ".gitignore failed to exclude: $dotenv_name"
    exit 1
  fi
done
if git -C "$ignore_case" check-ignore -q plugin.env.example; then
  print -u2 ".gitignore incorrectly excludes safe *.env.example templates"
  exit 1
fi

template_case="$tmp_dir/safe-env-example"
initialize_case "$template_case"
print -r -- 'HAWKSPAN_NODE_ID=documentation-placeholder' > "$template_case/plugin.env.example"
git -C "$template_case" add -f plugin.env.example
git -C "$template_case" -c user.name='Release Gate Test' \
  -c user.email='release-gate@invalid.example' commit -q -m 'safe environment template fixture'
HAWKSPAN_SCAN_ROOT="$template_case" zsh "$scanner" >/dev/null

public_product_case="$tmp_dir/public-simpletuner-product"
initialize_case "$public_product_case"
mkdir -p "$public_product_case/docs" "$public_product_case/examples"
print -r -- 'SimpleTuner is an authorized public HawkSpan integration.' > \
  "$public_product_case/docs/SIMPLETUNER.md"
print -r -- 'export const adapterName = "SimpleTuner";' > \
  "$public_product_case/examples/simpletuner-adapter.mjs"
git -C "$public_product_case" add docs/SIMPLETUNER.md examples/simpletuner-adapter.mjs
git -C "$public_product_case" -c user.name='Release Gate Test' \
  -c user.email='release-gate@invalid.example' commit -q -m 'public SimpleTuner integration fixture'
HAWKSPAN_SCAN_ROOT="$public_product_case" zsh "$scanner" >/dev/null

print "hawkspan privacy scanner mutation tests passed"
