#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SP_ROOT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_PREFIX="${SP_NODE22_CONDA_PREFIX:-$ROOT_DIR/.conda/sp-node22}"
ENV_FILE="${SP_NODE22_CONDA_FILE:-$ROOT_DIR/ops/conda/sp-node22.yml}"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing Node 22 env file: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_PREFIX")"
conda env update -p "$ENV_PREFIX" -f "$ENV_FILE" --prune

echo "Node 22 env ready at $ENV_PREFIX"
