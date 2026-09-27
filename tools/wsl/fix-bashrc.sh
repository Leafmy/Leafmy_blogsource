#!/usr/bin/env bash
# 把 wsl-dev-env 配置块移到 ~/.bashrc 的「非交互守卫」之前，
# 使 `bash -lc '...'` / ssh 登录 / 交互式终端都能拿到干净的 PATH 与 nvm。
set -uo pipefail

BRC="$HOME/.bashrc"
cp "$BRC" "$BRC.bak.$(date +%Y%m%d%H%M%S)"

echo "=== 1. 移除旧块 ==="
before=$(wc -l < "$BRC")
sed -i '\|^# >>> wsl-dev-env >>>$|,\|^# <<< wsl-dev-env <<<$|d' "$BRC"
after=$(wc -l < "$BRC")
echo "行数 $before -> $after（移除 $((before-after)) 行）"

echo "=== 2. 构造新块 ==="
cat > /tmp/wsl-dev-block.txt <<'EOF'
# >>> wsl-dev-env >>>
# 说明: 本块必须位于下方「非交互即 return」守卫之前，
#       否则 `bash -lc` 等非交互登录 shell 拿不到 node/npm。
#       由 tools/wsl/install-node.sh 写入。

# 1) 剔除 Windows 侧 node 路径，避免遮蔽 Linux node
_clean_path=""
IFS=':' read -ra _parts <<< "$PATH"
for _p in "${_parts[@]}"; do
  case "$_p" in
    "/mnt/"*"/node/bin"|"/mnt/"*"/.desktop-bin") continue ;;
  esac
  _clean_path="${_clean_path:+$_clean_path:}$_p"
done
export PATH="$_clean_path"
unset _clean_path _parts _p

# 2) nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# 3) 国内镜像
export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"
alias pn=pnpm 2>/dev/null || true
# <<< wsl-dev-env <<<
EOF

echo "=== 3. 插入到守卫之前 ==="
awk -v bf=/tmp/wsl-dev-block.txt '
  !done && /^case \$- in/ {
    while ((getline line < bf) > 0) print line
    close(bf); done = 1
  }
  { print }
  END { if (!done) print "WARN: 未找到守卫，块未插入" > "/dev/stderr" }
' "$BRC" > /tmp/bashrc.new

# 语法校验后再落盘
if bash -n /tmp/bashrc.new; then
  cp /tmp/bashrc.new "$BRC"
  echo "已写入，新行数: $(wc -l < "$BRC")"
else
  echo "!! 语法错误，未修改"; exit 1
fi
rm -f /tmp/bashrc.new /tmp/wsl-dev-block.txt

echo "=== 4. 结构确认 ==="
grep -n 'wsl-dev-env\|^case \$- in' "$BRC"

echo "=== 5. 登录非交互 shell 验证 ==="
bash -lc 'echo "flags=$-"; echo "node=$(command -v node) $(node -v 2>&1)"; echo "npm =$(command -v npm) $(npm -v 2>&1)"; echo "pnpm=$(command -v pnpm) $(pnpm -v 2>&1)"; echo "残留 Windows node 路径:"; echo "$PATH" | tr ":" "\n" | grep -E "/mnt/.*(node/bin|\.desktop-bin)$" || echo "  (无)"'

echo "=== 6. 交互式 shell 验证 ==="
bash -ic 'echo "node=$(command -v node) $(node -v 2>&1)"' 2>/dev/null | tail -1
echo "### BASHRC_FIX_DONE"
