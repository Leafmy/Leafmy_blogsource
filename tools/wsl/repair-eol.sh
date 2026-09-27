#!/usr/bin/env bash
# 修复 dos2unix -f 对二进制文件的误伤，并只对文本文件做 CRLF->LF
set -uo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
DST="$HOME/projects/leafmy-top"
cd "$DST" || exit 1

BINS="source/custom/assets/fontawesome/webfonts/fa-brands-400.woff2
source/custom/assets/fontawesome/webfonts/fa-solid-900.woff2
source/custom/assets/fonts/PingFang-Medium.woff2
source/custom/assets/fonts/fira-code/FiraCode-Bold.woff2
source/custom/assets/fonts/fira-code/FiraCode-Regular.woff2
source/custom/cursor/cursor-dark.png
source/custom/cursor/cursor-light.png
themes/hexo-theme-butterfly/source/img/butterfly-icon.png
themes/hexo-theme-butterfly/source/img/error-page.png
themes/hexo-theme-butterfly/source/img/friend_404.gif
themes/hexo-theme-butterfly/source/img/hexshane.jpg
themes/hexo-theme-butterfly/source/img/l3afovxs.jpg"

echo "############ [1/5] 确认二进制文件确实被破坏 ############"
damaged=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  a=$(md5sum "$SRC/$f" 2>/dev/null | cut -d' ' -f1)
  b=$(md5sum "$DST/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$a" != "$b" ]; then echo "  损坏: $f"; damaged=$((damaged+1)); fi
done <<< "$BINS"
echo "受损文件数: $damaged"

echo "############ [2/5] 从 Windows 源完整还原（撤销 dos2unix） ############"
rsync -a --delete --info=stats1 \
  --exclude='.git/' --exclude='node_modules/' --exclude='public/' \
  --exclude='.perf/' --exclude='.deploy*/' \
  "$SRC/" "$DST/" 2>&1 | tail -3

echo "############ [3/5] 校验二进制文件已恢复 ############"
bad=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  a=$(md5sum "$SRC/$f" 2>/dev/null | cut -d' ' -f1)
  b=$(md5sum "$DST/$f" 2>/dev/null | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "  ✔ $f" || { echo "  ✘ $f 仍不一致"; bad=$((bad+1)); }
done <<< "$BINS"
echo "仍不一致: $bad"

echo "############ [4/5] 仅文本文件归一化 CRLF -> LF ############"
n=0
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  if grep -qIU $'\r' "$f" 2>/dev/null; then
    sed -i 's/\r$//' "$f" && n=$((n+1))
  fi
done < <(git ls-files -z)
echo "已转换文本文件: $n"
echo "剩余含 CR 的已跟踪文件: $(git ls-files -z | xargs -0 grep -lIU $'\r' 2>/dev/null | wc -l)"

echo "############ [5/5] 最终一致性校验 ############"
git status --porcelain | grep -vE '^\?\?' | sort > /tmp/wsl-mod.txt
git -C "$SRC" status --porcelain | grep -vE '^\?\?' | sort > /tmp/win-mod.txt
echo "WSL 修改+删除: $(wc -l < /tmp/wsl-mod.txt)   Windows: $(wc -l < /tmp/win-mod.txt)"
if diff -u /tmp/win-mod.txt /tmp/wsl-mod.txt; then
  echo "✅ 修改+删除清单与 Windows 完全一致"
else
  echo "⚠️ 仍有差异（见上）"
fi
echo "--- 二进制内容二次校验 (全仓库 checksum dry-run) ---"
echo "差异条目: $(rsync -rcn --itemize-changes --exclude='.git/' --exclude='node_modules/' \
  --exclude='public/' --exclude='.perf/' --exclude='.deploy*/' --exclude='tools/' \
  "$SRC/" "$DST/" 2>&1 | grep -vE '^\.d' | wc -l)"
echo "--- 构建复验 ---"
npx hexo clean >/dev/null 2>&1
npx hexo generate 2>&1 | tail -3
echo "public 文件数: $(find "$DST/public" -type f | wc -l)"
echo "### REPAIR_DONE"
