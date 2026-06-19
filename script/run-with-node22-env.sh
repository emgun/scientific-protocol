#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SP_ROOT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_PREFIX="${SP_NODE22_CONDA_PREFIX:-$ROOT_DIR/.conda/sp-node22}"
INIT_SCRIPT="$ROOT_DIR/script/init-node22-env.sh"
NODE_MAJOR="$(node -p 'process.versions.node.split(`.`)[0]' 2>/dev/null || echo unknown)"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

if [ "${SP_NODE22_WRAPPED:-0}" = "1" ] || [ "$NODE_MAJOR" = "22" ]; then
  exec "$@"
fi

if ! command -v conda >/dev/null 2>&1; then
  echo "conda is required to use the project-local Node 22 environment" >&2
  exit 1
fi

if [ ! -x "$ENV_PREFIX/bin/node" ]; then
  bash "$INIT_SCRIPT" >&2
fi

printf -v QUOTED_CMD '%q ' "$@"
exec conda run -p "$ENV_PREFIX" bash -lc "cd $(printf '%q' "$ROOT_DIR") && export SP_NODE22_WRAPPED=1 && ${QUOTED_CMD}"
