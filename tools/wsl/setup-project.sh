#!/usr/bin/env bash
# 以 leaf 用户运行：把 leafmy-top 迁移为 WSL 原生开发副本
set -uo pipefail

SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
DST="$HOME/projects/leafmy-top"
REMOTE="git@github.com:Leafmy/Leafmy_blogsource.git"

echo "############ [1/6] 本地克隆（取 .git 与历史，不走网络） ############"
mkdir -p "$HOME/projects"
if [ -d "$DST/.git" ]; then
  echo "已存在 $DST，跳过克隆"
else
  git clone --quiet --no-hardlinks "$SRC" "$DST" || { echo "!! 克隆失败"; exit 1; }
  echo "克隆完成"
fi
cd "$DST"

echo "############ [2/6] 同步工作区（含 35 处未提交改动） ############"
rsync -a --info=stats2 \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='public/' \
  --exclude='.perf/' \
  --exclude='.deploy*/' \
  "$SRC/" "$DST/" 2>&1 | tail -8

echo "############ [3/6] 仓库配置（清理 Windows 专属配置） ############"
git config --unset http.proxy  2>/dev/null || true
git config --unset https.proxy 2>/dev/null || true
git config --unset core.sshCommand 2>/dev/null || true
git config core.autocrlf input
git config core.fileMode false
git config core.safecrlf false
git config core.ignorecase true
git config core.symlinks false
git remote set-url origin "$REMOTE"
echo "--- origin ---"; git remote -v
echo "--- 生效配置 ---"; git config --local --list | grep -vE '^(remote|branch)'

echo "############ [4/6] 与 Windows 侧状态比对 ############"
echo "改动数: $(git status --porcelain | wc -l)  (Windows 侧为 35)"
echo "--- 前 12 条 ---"
git status --porcelain | head -12
echo "--- HEAD ---"
git log --oneline -1

echo "############ [5/6] npm ci ############"
node -v; npm -v
time npm ci --no-audit --no-fund 2>&1 | tail -15

echo "############ [6/6] hexo 构建验证 ############"
npx hexo version 2>&1 | head -6
echo "--- hexo clean + generate ---"
time npx hexo clean 2>&1 | tail -3
time npx hexo generate 2>&1 | tail -20
echo "--- 产物统计 ---"
if [ -d "$DST/public" ]; then
  echo "public 文件数: $(find "$DST/public" -type f | wc -l)"
  du -sh "$DST/public"
  ls "$DST/public" | head -10
else
  echo "!! public 未生成"
fi
echo "### PROJECT_SETUP_DONE"
