#!/bin/zsh
set -euo pipefail

repo_root=${HAWKSPAN_SCAN_ROOT:-${0:A:h:h}}
cd "$repo_root"

git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z $git_root || ${git_root:A} != ${repo_root:A} ]]; then
  print -u2 "history scan requires this exact directory to be a Git worktree"
  exit 1
fi

privacy_pattern='/Users/har''ry|/Users/re''search|10\.44\.|019''f|twi''nk|al''ex|ad''ult|ejac''ulate|codex-mac-''link|com\.harry''hawk|\.codex-mac-''link'
secret_pattern='BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-'
# Broad indicators that often reveal a person's environment even when they are
# not credentials. Documentation-only placeholder accounts remain permitted.
personal_data_pattern='[A-Z0-9._%+-]+@(?!hawkspan\.invalid\b|invalid\.example\b)[A-Z0-9.-]+\.[A-Z]{2,}|(^|[^0-9])(10\.[0-9]{1,3}(\.[0-9]{1,3}){2}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2})([^0-9]|$)|[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}|(^|[^0-9A-F])([0-9A-F]{2}:){5}[0-9A-F]{2}([^0-9A-F]|$)|ssh-(rsa|ed25519) [A-Za-z0-9+/]{40,}={0,3}|/Users/(?!localuser(?:/|$)|peeruser(?:/|$))[^/[:space:]"]+'

scan_file() {
  local label=$1
  local file=$2
  local pattern=$3
  if rg -a -n -i -P "$pattern" "$file"; then
    print -u2 "$label scan failed"
    return 1
  fi
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/hawkspan-public-history.XXXXXX")
trap 'rm -rf -- "$tmp_dir"' EXIT

# Scan all reachable commit and annotated-tag metadata.
git rev-list --all > "$tmp_dir/commits"
while IFS= read -r object_id; do
  git cat-file -p "$object_id"
done < "$tmp_dir/commits" > "$tmp_dir/history-metadata"
git for-each-ref --format='%(objectname) %(objecttype)' refs/tags | while read -r object_id object_type; do
  [[ "$object_type" == tag ]] && git cat-file -p "$object_id"
done >> "$tmp_dir/history-metadata"
scan_file "history metadata privacy" "$tmp_dir/history-metadata" "$privacy_pattern"
scan_file "history metadata secret" "$tmp_dir/history-metadata" "$secret_pattern"
scan_file "history metadata personal data" "$tmp_dir/history-metadata" "$personal_data_pattern"

# Scan every path and blob reachable from every ref. The gate's own blob is
# excluded because its deliberately split detection vocabulary must live here.
git rev-list --objects --all > "$tmp_dir/reachable-objects"
sed -n 's/^[^ ]* //p' "$tmp_dir/reachable-objects" > "$tmp_dir/reachable-paths"
rg -P '(^|/)(?:\.env(?:\.[^/]*)?|[^/]+\.env(?:\.[^/]*)?)$' \
  "$tmp_dir/reachable-paths" > "$tmp_dir/dotenv-paths" || true
rg -v -P '(^|/)(?:\.env\.example|[^/]+\.env\.example)$' \
  "$tmp_dir/dotenv-paths" > "$tmp_dir/unsafe-dotenv-paths" || true
if [[ -s "$tmp_dir/unsafe-dotenv-paths" ]]; then
  cat "$tmp_dir/unsafe-dotenv-paths"
  print -u2 "reachable history contains a dotenv-family private path"
  exit 1
fi
# Object IDs are random hexadecimal identifiers and can coincidentally contain
# a blocked token. Scan the extracted repository paths, then scan blob contents
# separately below.
scan_file "reachable path privacy" "$tmp_dir/reachable-paths" "$privacy_pattern"
scan_file "reachable path secret" "$tmp_dir/reachable-paths" "$secret_pattern"
scan_file "reachable path personal data" "$tmp_dir/reachable-paths" "$personal_data_pattern"

while IFS=' ' read -r object_id object_path; do
  [[ -z ${object_path:-} ]] && continue
  [[ "$object_path" == scripts/check-public-history.sh ]] && continue
  [[ "$object_path" == scripts/check-release.sh ]] && continue
  [[ $(git cat-file -t "$object_id") == blob ]] || continue
  git cat-file blob "$object_id"
done < "$tmp_dir/reachable-objects" > "$tmp_dir/reachable-blobs"
scan_file "reachable blob privacy" "$tmp_dir/reachable-blobs" "$privacy_pattern"
scan_file "reachable blob secret" "$tmp_dir/reachable-blobs" "$secret_pattern"
scan_file "reachable blob personal data" "$tmp_dir/reachable-blobs" "$personal_data_pattern"

# Scan the actual distributable form, including archive paths. Quoting keeps
# this valid when the repository or system temporary directory contains spaces.
archive_path="$tmp_dir/hawkspan-source.tar"
archive_tree="$tmp_dir/archive tree"
mkdir -p "$archive_tree"
git archive --format=tar --output="$archive_path" HEAD
tar -xf "$archive_path" -C "$archive_tree"
if find "$archive_tree" \( -type f -o -type l \) \( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '*.env.*' \) \
  ! -name '*.env.example' -print | rg -q .; then
  print -u2 "release archive contains a dotenv-family private file"
  exit 1
fi
if rg -n --hidden -i \
  --glob '!**/scripts/check-public-history.sh' \
  --glob '!**/scripts/check-release.sh' \
  "$privacy_pattern" "$archive_tree"; then
  print -u2 "release archive privacy scan failed"
  exit 1
fi
if rg -n --hidden -i "$secret_pattern" "$archive_tree"; then
  print -u2 "release archive secret scan failed"
  exit 1
fi
if rg -a -n --hidden -i -P \
  --glob '!**/scripts/check-public-history.sh' \
  --glob '!**/scripts/check-release.sh' \
  "$personal_data_pattern" "$archive_tree"; then
  print -u2 "release archive personal-data scan failed"
  exit 1
fi

print "hawkspan public history and archive checks passed"
