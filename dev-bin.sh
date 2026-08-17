#!/usr/bin/env bash
exec bun run "$(dirname "$(readlink -f "$0")")/src/index.ts" "$@"
