#!/usr/bin/env bash
set -euo pipefail
: "${AURAL_MSVC_LINK:?Provide the absolute Visual Studio link.exe path}"
exec "$AURAL_MSVC_LINK" "$@"
