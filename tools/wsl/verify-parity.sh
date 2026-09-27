#!/usr/bin/env bash
cd "$HOME/projects/leafmy-top" || exit 1
echo "=== A. status 复跑（索引已刷新） ==="
git status --porcelain > /tmp/wsl-status.txt
echo "总条目: $(wc -l < /tmp/wsl-status.txt)"
awk '{print substr($0,1,2)}' /tmp/wsl-status.txt | sort | uniq -c | sort -rn
echo ""
echo "=== B. 内容一致性校验 (rsync checksum dry-run, Windows -> WSL) ==="
SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
rsync -rcn --itemize-changes \
  --exclude='.git/' --exclude='node_modules/' --exclude='public/' \
  --exclude='.perf/' --exclude='.deploy*/' \
  "$SRC/" "$HOME/projects/leafmy-top/" 2>&1 | grep -vE '^\.d' | head -30
echo "--- 差异条目数 (排除目录属性) ---"
rsync -rcn --itemize-changes \
  --exclude='.git/' --exclude='node_modules/' --exclude='public/' \
  --exclude='.perf/' --exclude='.deploy*/' \
  "$SRC/" "$HOME/projects/leafmy-top/" 2>&1 | grep -vE '^\.d' | wc -l
echo ""
echo "=== C. 关键未跟踪文件在仓库中的状态 ==="
for f in source/custom/effects/space-globe.js source/img tools source/_retired; do
  printf "%-46s tracked=%s ignored=%s\n" "$f" \
    "$(git ls-files --error-unmatch "$f" >/dev/null 2>&1 && echo yes || echo no)" \
    "$(git check-ignore -q "$f" && echo yes || echo no)"
done
echo ""
echo "=== D. 两侧 .gitignore 是否一致 ==="
diff <(cat "$SRC/.gitignore") <(cat .gitignore) >/dev/null && echo "一致" || echo "不一致"
echo ""
echo "=== E. nvm 加载测试 ==="
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
echo "node=$(command -v node) $(node -v)"
echo "npm =$(command -v npm) $(npm -v)"
echo "=== DONE ==="
