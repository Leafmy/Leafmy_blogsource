#!/usr/bin/env bash
# WSL2 开发环境 - 基础系统依赖安装
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "### [1/3] apt update (TUNA mirror)"
sudo apt-get update -qq

echo "### [2/3] 安装基础工具链"
sudo apt-get install -y -qq --no-install-recommends \
  build-essential \
  python3 python3-pip python3-venv python3-dev \
  pkg-config libssl-dev \
  ca-certificates gnupg lsb-release \
  curl wget git unzip zip tar xz-utils \
  jq ripgrep fd-find fzf \
  tmux htop tree less nano vim \
  sqlite3 file procps net-tools \
  openssh-client rsync

echo "### [3/3] 验证"
for c in gcc g++ make python3 pip3 git curl jq rg fzf tmux sqlite3 unzip; do
  p=$(command -v "$c" 2>/dev/null)
  if [ -n "$p" ]; then printf "  OK   %-10s %s\n" "$c" "$p"; else printf "  MISS %-10s\n" "$c"; fi
done
echo "### BASE_INSTALL_DONE"
