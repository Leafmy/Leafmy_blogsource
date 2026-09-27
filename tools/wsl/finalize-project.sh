#!/usr/bin/env bash
# 以 leaf 用户运行：使 WSL 副本与 Windows 工作区完全对齐 + 行尾归一化 + 安装依赖 + 构建
set -uo pipefail
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
DST="$HOME/projects/leafmy-top"
cd "$DST" || exit 1

echo "############ [0/7] 定位 267 个 ' M' 的真实来源 ############"
echo "package.json 状态: [$(git status --porcelain -- package.json)]"
echo "git diff-files 数: $(git diff-files --name-only | wc -l)"
echo "git diff       数: $(git diff --name-only | wc -l)"
echo "含 CR 的已跟踪文件数: $(git ls-files -z | xargs -0 grep -lIU $'\r' 2>/dev/null | wc -l)"

echo "############ [1/7] 精确对齐（含删除同步） ############"
rsync -a --delete --info=stats1 \
  --exclude='.git/' --exclude='node_modules/' --exclude='public/' \
  --exclude='.perf/' --exclude='.deploy*/' \
  "$SRC/" "$DST/" 2>&1 | tail -4
echo "对齐后 status 条目: $(git status --porcelain | wc -l)"

echo "############ [2/7] 行尾归一化 CRLF -> LF（仅已跟踪文本文件） ############"
if ! command -v dos2unix >/dev/null 2>&1; then
  sudo apt-get install -y -qq --no-install-recommends dos2unix >/dev/null 2>&1
fi
command -v dos2unix && dos2unix --version 2>&1 | head -1
git ls-files -z | xargs -0 -r dos2unix -q -f 2>/dev/null
echo "剩余含 CR 的已跟踪文件数: $(git ls-files -z | xargs -0 grep -lIU $'\r' 2>/dev/null | wc -l)"

echo "############ [3/7] 归一化后 status ############"
git status --porcelain > /tmp/wsl-final-status.txt
echo "总条目: $(wc -l < /tmp/wsl-final-status.txt)  (Windows 侧 35, 差额 = .perf/ 未同步)"
awk '{print substr($0,1,2)}' /tmp/wsl-final-status.txt | sort | uniq -c | sort -rn
echo "--- 与 Windows 的修改/删除清单比对 ---"
git status --porcelain | grep -vE '^\?\?' | sort > /tmp/wsl-mod.txt
git -C "$SRC" status --porcelain | grep -vE '^\?\?' | sort > /tmp/win-mod.txt
if diff -u /tmp/win-mod.txt /tmp/wsl-mod.txt; then
  echo "✅ 修改+删除清单与 Windows 完全一致"
else
  echo "⚠️ 存在差异（见上）"
fi

echo "############ [4/7] npm ci ############"
echo "node $(node -v) / npm $(npm -v)"
time npm ci --no-audit --no-fund 2>&1 | tail -12

echo "############ [5/7] hexo 版本 ############"
npx hexo version 2>&1 | head -8

echo "############ [6/7] hexo 构建 ############"
npx hexo clean 2>&1 | tail -2
time npx hexo generate 2>&1 | tail -25

echo "############ [7/7] 产物校验 ############"
if [ -d "$DST/public" ]; then
  echo "public 文件数: $(find "$DST/public" -type f | wc -l)"
  du -sh "$DST/public"
  echo "--- 顶层产物 ---"; ls "$DST/public" | head -12
  echo "--- index.html 大小 ---"; ls -la "$DST/public/index.html" 2>/dev/null
else
  echo "!! public 未生成"
fi
echo "### FINALIZE_DONE"
