#!/usr/bin/env bash
cd "$HOME/projects/leafmy-top" || exit 1
echo "=== status 按状态码分类 ==="
git status --porcelain | awk '{print substr($0,1,2)}' | sort | uniq -c | sort -rn
echo ""
echo "=== 非 diff 类条目样本 (?? / 其他) ==="
git status --porcelain | grep -vE '^ M|^ D|^M ' | head -20
echo ""
echo "=== 未跟踪条目计数 ==="
git status --porcelain | grep -c '^??' || true
echo ""
echo "=== git diff (无 ignore) 文件数 ==="
git diff --numstat | wc -l
echo "=== 其中行尾仅差异的文件 (numstat 大于真实改动) ==="
git diff --numstat | head -20
echo ""
echo "=== DONE ==="
