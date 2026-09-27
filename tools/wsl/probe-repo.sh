#!/usr/bin/env bash
echo "=== 仓库可见性 (HTTPS 匿名) ==="
GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/Leafmy/Leafmy_blogsource.git 2>&1 | head -5
echo "=== Windows SSH 密钥存在性 ==="
ls -la /mnt/c/Users/Leaf_/.ssh/ 2>/dev/null
echo "=== WSL ~/.ssh ==="
ls -la "$HOME/.ssh/" 2>/dev/null || echo "(不存在)"
echo "=== 项目 git 关键信息 (Windows 侧) ==="
P="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
git -C "$P" ls-files | wc -l
echo "--- 顶层被跟踪目录 ---"
git -C "$P" ls-files | awk -F/ 'NF>1{print $1}' | sort -u | head -20
echo "--- themes 是否被跟踪 ---"
git -C "$P" ls-files themes/ | head -3
echo "count=$(git -C "$P" ls-files themes/ | wc -l)"
echo "--- submodule? ---"
ls -la "$P/.gitmodules" 2>/dev/null || echo "(无 .gitmodules)"
echo "=== 工作区是否干净 ==="
git -C "$P" status --porcelain | head -20
echo "count_changes=$(git -C "$P" status --porcelain | wc -l)"
echo "=== scripts/ 目录 ==="
ls "$P/scripts/" 2>/dev/null
echo "=== .github/workflows ==="
ls "$P/.github/workflows/" 2>/dev/null
echo "=== _config.yml 关键项 ==="
grep -nE '^(title|url|root|deploy|theme|language|timezone):' "$P/_config.yml" 2>/dev/null
echo "=== DONE ==="
