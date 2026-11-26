#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  node_bin="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
fi
if ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)' 2>/dev/null; then
  printf 'Нужен Node.js 22 или новее: https://nodejs.org/\n'
  read -r -p 'Нажми Enter, чтобы закрыть окно. '
  exit 1
fi
exec "$node_bin" wb-live.cjs "$@"
