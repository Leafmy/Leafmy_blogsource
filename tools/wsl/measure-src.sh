#!/usr/bin/env bash
SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
echo "=== 顶层条目体积 ==="
du -sh "$SRC"/* "$SRC"/.git "$SRC"/.github "$SRC"/.perf 2>/dev/null | sort -rh
echo "=== >5MB 的目录/文件 (排除 node_modules/public/.git) ==="
find "$SRC" -mindepth 1 -maxdepth 3 \
  \( -name node_modules -o -name public -o -name .git \) -prune -o \
  -type d -print 2>/dev/null | while read -r d; do
    s=$(du -sm "$d" 2>/dev/null | cut -f1)
    [ "${s:-0}" -ge 5 ] && echo "${s}M  $d"
  done | sort -rn | head -20
echo "=== 文件数 ==="
echo "worktree files (excl node_modules/public/.git):"
find "$SRC" \( -name node_modules -o -name public -o -name .git \) -prune -o -type f -print 2>/dev/null | wc -l
