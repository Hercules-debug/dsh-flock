#!/usr/bin/env bash
# Symlink the host's @deepseek-ai packages next to the plugin so its
# peer-dependency imports resolve outside a running dsh profile. Only needed to
# run the test suite standalone; inside a profile they are already present.
set -euo pipefail
HOST="${1:-$HOME/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai}"
mkdir -p node_modules/@deepseek-ai
for p in schemastery dsh-tools cordis dsh-brand; do
  if [ -e "$HOST/$p" ]; then
    ln -sfn "$HOST/$p" "node_modules/@deepseek-ai/$p"
    echo "linked $p"
  else
    echo "skip $p (not in host)"
  fi
done
