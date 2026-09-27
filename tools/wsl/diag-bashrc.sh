#!/usr/bin/env bash
echo "=== bashrc 前 25 行 ==="
head -25 "$HOME/.bashrc" | cat -n
echo ""
echo "=== 交互式守卫检查 ==="
grep -n 'case \$- in' -A3 "$HOME/.bashrc" || echo "(无守卫)"
echo ""
echo "=== wsl-dev-env 块位置 ==="
grep -n 'wsl-dev-env' "$HOME/.bashrc"
echo "总行数: $(wc -l < "$HOME/.bashrc")"
echo ""
echo "=== 登录非交互 shell 的 \$- ==="
bash -lc 'echo "flags=$-"; echo "interactive=$([ -z "${PS1:-}" ] && echo no || echo yes)"'
echo ""
echo "=== 登录 shell 中 PATH 是否含 Windows node ==="
bash -lc 'echo "$PATH"' | tr ':' '\n' | grep -nE '/mnt/' | head -10
echo ""
echo "=== .profile 是否 source .bashrc ==="
grep -n 'bashrc' "$HOME/.profile" || echo "(未 source)"
echo ""
echo "=== /etc/profile.d 中是否有改动 PATH 的脚本 ==="
grep -rln 'PATH' /etc/profile.d/ 2>/dev/null
echo ""
echo "=== 模式匹配自测 ==="
for p in "/mnt/c/Users/Leaf_/AppData/Roaming/dsh-desktop/harness/.desktop-bin" \
         "/mnt/c/Users/Leaf_/AppData/Local/Programs/DSH Desktop/resources/app/node_modules/node/bin"; do
  case "$p" in
    "/mnt/"*"/node/bin"|"/mnt/"*"/.desktop-bin") echo "MATCH   $p" ;;
    *) echo "NOMATCH $p" ;;
  esac
done
echo "=== DONE ==="
