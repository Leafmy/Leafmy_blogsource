#!/usr/bin/env bash
# 以 leaf 用户运行：nvm + Node 22 LTS + pnpm + 国内镜像 + PATH 遮蔽修复
set -uo pipefail
export NVM_DIR="$HOME/.nvm"
NODE_MIRROR="https://npmmirror.com/mirrors/node"
NVM_VERSION="v0.40.3"

echo "############ [1/6] 安装 nvm ############"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm 已存在，跳过克隆"
else
  rm -rf "$NVM_DIR"
  ok=0
  for url in https://gitee.com/mirrors/nvm.git https://github.com/nvm-sh/nvm.git; do
    echo "--- 尝试克隆 $url"
    if git clone --quiet "$url" "$NVM_DIR" 2>&1; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "!! nvm 克隆失败"; exit 1; }
fi
cd "$NVM_DIR"
git fetch --quiet --tags --depth 1 origin 2>/dev/null
if git rev-parse -q --verify "refs/tags/$NVM_VERSION" >/dev/null 2>&1; then
  git checkout --quiet "$NVM_VERSION"
  echo "已切到 $NVM_VERSION"
else
  echo "警告: 未找到 tag $NVM_VERSION，使用当前 HEAD"
fi
echo "nvm 版本: $(git describe --tags 2>/dev/null || echo unknown)"

echo "############ [2/6] 加载 nvm 并安装 Node 22 LTS ############"
export NVM_NODEJS_ORG_MIRROR="$NODE_MIRROR"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22 2>&1 | tail -20
nvm alias default 22
nvm use default >/dev/null
echo "node -> $(command -v node)  $(node --version)"
echo "npm  -> $(command -v npm)  $(npm --version)"

echo "############ [3/6] npm 国内镜像 + pnpm ############"
npm config set registry https://registry.npmmirror.com
npm config set disturl "$NODE_MIRROR"
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm config set sharp_binary_host https://npmmirror.com/mirrors/sharp
npm config set sharp_libvips_binary_host https://npmmirror.com/mirrors/sharp-libvips
echo "registry = $(npm config get registry)"
npm install -g pnpm 2>&1 | tail -5
echo "pnpm -> $(command -v pnpm)  $(pnpm --version 2>&1)"

echo "############ [4/6] 配置 ~/.bashrc ############"
# 注意：必须插到 Ubuntu 默认 .bashrc 的「非交互即 return」守卫之前，
#       否则 `bash -lc '...'`、ssh 命令等非交互登录 shell 拿不到 node/npm。
MARK_BEGIN="# >>> wsl-dev-env >>>"
MARK_END="# <<< wsl-dev-env <<<"
cp "$HOME/.bashrc" "$HOME/.bashrc.bak.$(date +%Y%m%d%H%M%S)"
sed -i "\|$MARK_BEGIN|,\|$MARK_END|d" "$HOME/.bashrc" 2>/dev/null || true

cat > /tmp/wsl-dev-block.txt <<'EOF'
# >>> wsl-dev-env >>>
# 本块位于下方「非交互即 return」守卫之前，确保 bash -lc 也能拿到 node/npm。
# 由 tools/wsl/install-node.sh 写入。
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
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"
alias pn=pnpm 2>/dev/null || true
# <<< wsl-dev-env <<<
EOF

awk -v bf=/tmp/wsl-dev-block.txt '
  !done && /^case \$- in/ {
    while ((getline line < bf) > 0) print line
    close(bf); done = 1
  }
  { print }
' "$HOME/.bashrc" > /tmp/bashrc.new

if bash -n /tmp/bashrc.new; then
  cp /tmp/bashrc.new "$HOME/.bashrc"
  echo "写入完成（块位于守卫之前）"
else
  echo "!! ~/.bashrc 语法校验失败，未修改"; exit 1
fi
rm -f /tmp/bashrc.new /tmp/wsl-dev-block.txt
grep -n "$MARK_BEGIN\|^case \$- in" "$HOME/.bashrc"

echo "############ [5/6] 登录 shell 验证 ############"
bash -lc 'echo "node: $(command -v node) $(node -v 2>&1)"; echo "npm:  $(command -v npm) $(npm -v 2>&1)"; echo "pnpm: $(command -v pnpm) $(pnpm -v 2>&1)"' 2>&1

echo "############ [6/6] 结果 ############"
bash -lc 'node -e "console.log(\"Node \" + process.version + \" on \" + process.platform + \"/\" + process.arch)"'
echo "### NODE_INSTALL_DONE"
