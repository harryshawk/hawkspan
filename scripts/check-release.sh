#!/bin/sh
set -eu

exec "${NODE:-node}" "$(dirname "$0")/check-release.mjs" "$@"
