#!/bin/sh
# 把 src/ 里的源文件拼成 Obsidian 可以直接加载的 main.js（不需要 npm 依赖）
set -e
cd "$(dirname "$0")"
cat src/core.js src/chat.js src/fav.js src/notes.js src/attach.js > main.js
node --check main.js && echo "built main.js ($(wc -c < main.js) bytes)"
