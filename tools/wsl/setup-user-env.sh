#!/usr/bin/env bash
# 以 leaf 用户运行：补充镜像配置 + iproute2 由 root 另装
set -uo pipefail

echo "############ [1/5] ~/.npmrc 扩展镜像 ############"
cat > "$HOME/.npmrc" <<'EOF'
registry=https://registry.npmmirror.com
disturl=https://npmmirror.com/mirrors/node
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
sharp_binary_host=https://npmmirror.com/mirrors/sharp
sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips
sass_binary_site=https://npmmirror.com/mirrors/node-sass
puppeteer_download_host=https://npmmirror.com/mirrors
EOF
echo "已写入 ~/.npmrc:"; cat "$HOME/.npmrc"

echo "############ [2/5] 全局 git 身份与行为 ############"
git config --global user.name  "关小叶"
git config --global user.email "2994832083@qq.com"
git config --global init.defaultBranch main
git config --global core.autocrlf input
git config --global core.fileMode false
git config --global core.safecrlf false
git config --global core.quotepath false
git config --global pull.rebase false
git config --global push.default simple
git config --global safe.directory '*'
git config --global --list

echo "############ [3/5] SSH 密钥接入 (从 Windows 复制) ############"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
WS="/mnt/c/Users/Leaf_/.ssh"
if [ -f "$HOME/.ssh/id_ed25519" ]; then
  echo "WSL 侧密钥已存在，跳过"
else
  cp "$WS/id_ed25519" "$HOME/.ssh/id_ed25519" && chmod 600 "$HOME/.ssh/id_ed25519"
  cp "$WS/id_ed25519.pub" "$HOME/.ssh/id_ed25519.pub" 2>/dev/null && chmod 644 "$HOME/.ssh/id_ed25519.pub"
  echo "已复制 Windows id_ed25519"
fi
chmod 600 "$HOME/.ssh/id_ed25519" 2>/dev/null
ls -la "$HOME/.ssh/"
ssh-keygen -lf "$HOME/.ssh/id_ed25519.pub" 2>&1 || true

echo "--- 添加 github.com host key ---"
touch "$HOME/.ssh/known_hosts"; chmod 644 "$HOME/.ssh/known_hosts"
ssh-keygen -R github.com -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1
ssh-keyscan -t ed25519,rsa github.com 2>/dev/null >> "$HOME/.ssh/known_hosts"
echo "known_hosts 行数: $(wc -l < "$HOME/.ssh/known_hosts")"

cat > "$HOME/.ssh/config" <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  ServerAliveInterval 30
  ConnectTimeout 20
EOF
chmod 600 "$HOME/.ssh/config"

echo "--- SSH 认证测试 ---"
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -T git@github.com 2>&1 | head -3

echo "############ [4/5] 源目录体积分布 ############"
SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
du -sh "$SRC" 2>/dev/null
for d in node_modules public .git "source/custom/cursor" themes source; do
  [ -e "$SRC/$d" ] && du -sh "$SRC/$d" 2>/dev/null
done

echo "############ [5/5] 完成 ############"
echo "### PREP_DONE"
