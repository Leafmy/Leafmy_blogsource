#!/usr/bin/env bash
# WSL2 开发环境体检 —— 一条命令查看全部关键状态
# 用法: bash tools/wsl/wslenv.sh
set -uo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; D=$'\e[2m'; N=$'\e[0m'
ok(){ printf "  ${G}✔${N} %-18s %s\n" "$1" "$2"; }
bad(){ printf "  ${R}×${N} %-18s %s\n" "$1" "$2"; }
warn(){ printf "  ${Y}!${N} %-18s %s\n" "$1" "$2"; }
sec(){ printf "\n${C}▌%s${N}\n" "$1"; }
# 版本探测：按命令取合适的 flag
ver(){ case "$1" in tmux) "$1" -V 2>&1 | head -1 ;;
                     python3|python) "$1" --version 2>&1 | head -1 ;;
                     *) "$1" --version 2>&1 | head -1 ;; esac; }

sec "WSL / 系统"
ok "发行版"      "${WSL_DISTRO_NAME:-?}  $(grep -oP '(?<=^PRETTY_NAME=\").*(?=\")' /etc/os-release)"
ok "内核"        "$(uname -r)"
ok "用户"        "$(whoami) (uid=$(id -u))  HOME=$HOME"
ok "时区 / 时间" "$(date '+%Z %Y-%m-%d %H:%M:%S')"
ok "CPU / 内存"  "$(nproc) 核 / $(free -h | awk '/^Mem:/{print $2}')"
ok "根分区可用"  "$(df -h / | awk 'NR==2{print $4}')"
case "$(ps -p 1 -o comm= 2>/dev/null)" in
  systemd*) ok "init" "systemd 已启用" ;;
  *) warn "init" "$(ps -p 1 -o comm= 2>/dev/null) (未启用 systemd)" ;;
esac
[ "$(ip route show default 2>/dev/null | awk '{print $3}')" = "" ] \
  && warn "宿主 IP" "未取到默认网关" || ok "宿主 IP" "$(ip route show default | awk '{print $3}')"

sec "工具链"
for c in git node npm pnpm python3 pip3 gcc make jq rg fzf tmux sqlite3 sudo dos2unix; do
  if p=$(command -v "$c" 2>/dev/null); then
    v=$(ver "$c" | cut -c1-52)
    case "$p" in /mnt/*) bad "$c" "$p  ${R}← Windows 二进制!${N}" ;;
                   *) ok "$c" "$v" ;; esac
  else bad "$c" "未安装"; fi
done

sec "PATH 遮蔽检查（以登录 shell 为准）"
login_path=$(bash -lc 'echo "$PATH"' 2>/dev/null)
shadow=$(echo "$login_path" | tr ':' '\n' | grep -E '^/mnt/.*(node/bin|\.desktop-bin)$' || true)
if [ -z "$shadow" ]; then ok "登录 shell PATH" "已剔除 Windows node 路径"
else bad "登录 shell PATH" "仍含: $(echo "$shadow" | tr '\n' ' ')"; fi
if grep -qF '# >>> wsl-dev-env >>>' "$HOME/.bashrc" 2>/dev/null; then
  ok "~/.bashrc 配置块" "wsl-dev-env 已存在"
else bad "~/.bashrc 配置块" "缺失（PATH 清理/nvm 不会自动加载）"; fi
login_node=$(bash -lc 'command -v node' 2>/dev/null)
case "$login_node" in
  "$HOME/.nvm/"*) ok "登录 shell node" "$login_node" ;;
  *) bad "登录 shell node" "${login_node:-未找到}" ;;
esac

sec "nvm / Node"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  ok "nvm" "$(cd "$NVM_DIR" && git describe --tags 2>/dev/null || echo '已安装')"
  ok "默认版本" "$(nvm version default 2>/dev/null)"
  installed=$(ls "$NVM_DIR/versions/node" 2>/dev/null | tr '\n' ' ')
  ok "已装版本" "${installed:-无}"
else bad "nvm" "未安装"; fi
ok "node" "$(node -v 2>/dev/null)  npm $(npm -v 2>/dev/null)  pnpm $(pnpm -v 2>/dev/null)"

sec "npm 镜像"
ok "registry" "$(npm config get registry 2>/dev/null)"
ok "node 镜像" "$(grep -m1 disturl "$HOME/.npmrc" 2>/dev/null | cut -d= -f2- || echo '默认')"

sec "Git 与 GitHub"
ok "user.name"  "$(git config --global user.name)"
ok "user.email" "$(git config --global user.email)"
ok "autocrlf"   "$(git config --global core.autocrlf)"
if [ -f "$HOME/.ssh/id_ed25519" ]; then
  ok "SSH 私钥" "$(ssh-keygen -lf "$HOME/.ssh/id_ed25519.pub" 2>/dev/null | awk '{print $2}')"
else bad "SSH 私钥" "缺失"; fi
# GitHub 的 SSH 认证成功时也会返回退出码 1，需按输出判定
gh_out=$(timeout 15 ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 || true)
if grep -qi 'successfully authenticated' <<< "$gh_out"; then
  ok "GitHub 认证" "$(echo "$gh_out" | head -1)"
elif grep -qi 'permission denied\|could not resolve\|connection timed out' <<< "$gh_out"; then
  bad "GitHub 认证" "$(echo "$gh_out" | head -1)"
else warn "GitHub 认证" "$(echo "$gh_out" | head -1)"; fi

sec "项目"
P="$HOME/projects/leafmy-top"
if [ -d "$P/.git" ]; then
  ok "路径" "$P"
  ok "HEAD" "$(git -C "$P" log --oneline -1)"
  ok "分支" "$(git -C "$P" rev-parse --abbrev-ref HEAD)"
  ok "remote" "$(git -C "$P" remote get-url origin)"
  ok "改动" "$(git -C "$P" status --porcelain | grep -vcE '^\?\?' || echo 0) 处修改/删除, $(git -C "$P" status --porcelain | grep -cE '^\?\?' || echo 0) 处未跟踪"
  ok "依赖" "$([ -d "$P/node_modules" ] && echo "node_modules 已安装 ($(ls "$P/node_modules" | wc -l) 包)" || echo '未安装')"
  ok "构建产物" "$([ -d "$P/public" ] && echo "public/ $(find "$P/public" -type f | wc -l) 文件, $(du -sh "$P/public" | cut -f1)" || echo '未构建')"
  if [ -f "$P/node_modules/.bin/hexo" ]; then
    ok "hexo" "$(cd "$P" && ./node_modules/.bin/hexo version 2>/dev/null | head -1)"
  fi
else bad "项目" "$P 不存在"; fi

printf "\n${D}提示: 编辑器用 VS Code Remote-WSL 打开 ~/projects/leafmy-top${N}\n"
