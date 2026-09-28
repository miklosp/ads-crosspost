#!/bin/sh
# Writes the App Store Connect .p8 from $APPLE_API_KEY_P8 to a 0600 temp file,
# points APPLE_API_KEY (electron-builder wants a path) at it, runs "$@", deletes it.
set -eu
: "${APPLE_API_KEY_P8:?not set; run via: op run --env-file=.env.op -- pnpm app:dist:signed}"
: "${APPLE_API_KEY_ID:?not set}"
: "${APPLE_API_ISSUER:?not set}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
trap 'exit 130' INT TERM
key="$dir/AuthKey_$APPLE_API_KEY_ID.p8"
(umask 077 && printf '%s\n' "$APPLE_API_KEY_P8" > "$key")
unset APPLE_API_KEY_P8
APPLE_API_KEY="$key" "$@"
