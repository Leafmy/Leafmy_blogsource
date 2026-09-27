#!/usr/bin/env bash
set -uo pipefail
SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
DST="$HOME/projects/leafmy-top"
cd "$DST" || exit 1
mkdir -p tools/wsl
cp -f "$SRC"/tools/wsl/* tools/wsl/ 2>/dev/null
for f in tools/wsl/*.sh; do
  [ -f "$f" ] || continue
  sed -i 's/\r$//' "$f"; chmod +x "$f"
done
echo "已同步 $(ls tools/wsl | wc -l) 个文件到 $DST/tools/wsl"
ls tools/wsl
echo ""
echo "=== 最终体检摘要 ==="
bash tools/wsl/wslenv.sh 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
