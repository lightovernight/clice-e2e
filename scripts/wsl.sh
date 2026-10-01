#!/usr/bin/env bash
# Run the CLI inside WSL against a Linux clice:   npm run wsl -- e2e examples/lambda.cpp
#
# The checkout on the Windows drive is mirrored to the Linux file system (node_modules holds
# native modules, and clice is much faster off the Windows mount), built there, and run there.
# A Windows path to a single source file (C:/dir/file.cpp) is copied into targets/ and replayed
# from there; other Windows paths are translated to /mnt/... paths.
#
#   CLICE_E2E_WSL_DIR  where the mirror lives          (default: ~/clice-e2e)
#   CLICE              the Linux clice written into the mirror's clice-e2e.json on the first run
#                      (default: a clice on PATH); later runs use that file, edit it to switch
#   CXX_STD            -std for files in targets/      (default: c++17)
set -euo pipefail

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mirror="${CLICE_E2E_WSL_DIR:-$HOME/clice-e2e}"

mkdir -p "$mirror/targets"
rsync -a --delete --exclude compile_commands.json "$source_root"/{src,test,scripts,examples} "$mirror/"
rsync -a "$source_root"/{package.json,package-lock.json,tsconfig.json} "$mirror/"
cd "$mirror"

# Reinstall only when the lock file changed.
lock="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ "$(cat node_modules/.lock-hash 2>/dev/null || true)" != "$lock" ]; then
  npm ci --no-audit --no-fund >&2
  echo "$lock" > node_modules/.lock-hash
fi

arguments=()
for argument in "$@"; do
  if [[ "$argument" =~ ^[A-Za-z]:[\\/] ]]; then
    path="$(wslpath -u "$argument")"
    if [ "${#arguments[@]}" -eq 1 ] && [ -f "$path" ] && [[ "$path" =~ \.(c|cc|cpp|cxx|h|hpp)$ ]]; then
      cp "$path" targets/
      path="targets/$(basename "$path")"
    fi
    arguments+=("$path")
  else
    arguments+=("$argument")
  fi
done

node scripts/setup.js >&2
npm run build --silent
exec node dist/src/cli.js "${arguments[@]}"
