#!/usr/bin/env bash
# 同步工具脚本到 WSL 副本 + 端到端最终验证
set -uo pipefail
SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
DST="$HOME/projects/leafmy-top"
cd "$DST" || exit 1

echo "############ [1/4] 同步 tools/wsl ############"
mkdir -p tools/wsl
cp -f "$SRC"/tools/wsl/* tools/wsl/ 2>/dev/null
for f in tools/wsl/*.sh; do
  [ -f "$f" ] || continue
  sed -i 's/\r$//' "$f"; chmod +x "$f"
done
echo "已同步 $(ls tools/wsl | wc -l) 个文件"

echo "############ [2/4] 端到端构建验证 ############"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
echo "node $(node -v) | npm $(npm -v) | pnpm $(pnpm -v)"
npx hexo clean >/dev/null 2>&1
start=$(date +%s%N)
npx hexo generate > /tmp/gen.log 2>&1
rc=$?
end=$(date +%s%N)
tail -2 /tmp/gen.log
echo "退出码=$rc  耗时=$(( (end-start)/1000000 )) ms"
echo "public 文件数: $(find public -type f 2>/dev/null | wc -l)  体积: $(du -sh public 2>/dev/null | cut -f1)"
echo "index.html: $(stat -c%s public/index.html 2>/dev/null) 字节"
echo "--- 关键产物抽检 ---"
for f in public/index.html public/search.json public/css/index.css public/custom/effects/space-globe.js; do
  [ -f "$f" ] && echo "  ✔ $f" || echo "  · $f (不存在)"
done

echo "############ [3/4] git 两侧一致性 ############"
git status --porcelain | grep -vE '^\?\?' | sort > /tmp/w.txt
git -C "$SRC" status --porcelain | grep -vE '^\?\?' | sort > /tmp/m.txt
if diff -q /tmp/m.txt /tmp/w.txt >/dev/null; then
  echo "✅ 修改/删除清单完全一致（$(wc -l < /tmp/w.txt) 项）"
else
  echo "⚠️ 差异:"; diff -u /tmp/m.txt /tmp/w.txt
fi
echo "WSL 未跟踪: $(git status --porcelain | grep -cE '^\?\?') 项"

echo "############ [4/4] 最终体检 ############"
bash tools/wsl/wslenv.sh
echo "### VERIFY_DONE"
