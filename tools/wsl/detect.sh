#!/usr/bin/env bash
# WSL2 开发环境检测脚本
echo "=== WHOAMI ==="
whoami; echo "HOME=$HOME"; id -u
echo "=== KERNEL ==="
uname -a
echo "=== OS ==="
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
echo "=== WSL ENV ==="
echo "WSL_DISTRO_NAME=$WSL_DISTRO_NAME"
echo "WSL_INTEROP=$WSL_INTEROP"
echo "WSLENV=$WSLENV"
cat /etc/wsl.conf 2>/dev/null || echo "(no /etc/wsl.conf)"
echo "=== SYSTEMD ==="
ps -p 1 -o comm= 2>/dev/null
echo "=== TOOLCHAIN ==="
for c in git node npm pnpm yarn bun python3 pip3 docker docker-compose go rustc cargo java gcc g++ make cmake curl wget unzip zip jq rg fd fzf tmux code sqlite3 openssl ssh; do
  p=$(command -v "$c" 2>/dev/null)
  if [ -n "$p" ]; then
    v=$("$c" --version 2>&1 | head -1)
    printf "%-16s OK   %-34s %s\n" "$c" "$p" "$v"
  else
    printf "%-16s MISS\n" "$c"
  fi
done
echo "=== RUNTIME DIRS ==="
for d in "$HOME/.nvm" "$HOME/.local/share/pnpm" "$HOME/.bun" "$HOME/.cargo" "$HOME/.rustup" "$HOME/.pyenv" "$HOME/.volta"; do
  [ -e "$d" ] && echo "EXISTS $d" || echo "NONE   $d"
done
echo "=== SHELL RC FILES ==="
ls -la "$HOME"/.bashrc "$HOME"/.profile "$HOME"/.zshrc "$HOME"/.bash_aliases 2>/dev/null
echo "=== NPM CONFIG ==="
npm config get prefix 2>/dev/null
npm config get registry 2>/dev/null
echo "=== DISK ==="
df -h / /mnt/c 2>/dev/null | head -5
echo "=== MEM/CPU ==="
nproc; free -h | head -2
echo "=== NETWORK ==="
curl -s -o /dev/null -w "registry.npmjs.org -> %{http_code}\n" --max-time 8 https://registry.npmjs.org/ 2>&1
echo "=== DONE ==="
