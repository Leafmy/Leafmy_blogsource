#!/usr/bin/env bash
# 以 root 运行：恢复完整 sudoers（保留 leaf NOPASSWD）
set -uo pipefail
TMP=/tmp/sudoers.new

cat > "$TMP" <<'EOF'
#
# This file MUST be edited with the 'visudo' command as root.
#
Defaults        env_reset
Defaults        mail_badpass
Defaults        secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
Defaults        use_pty

# User privilege specification
root    ALL=(ALL:ALL) ALL

# Members of the admin group may gain root privileges
%admin ALL=(ALL) ALL

# Allow members of group sudo to execute any command
%sudo   ALL=(ALL:ALL) ALL

# See sudoers(5) for more information on "@include" directives:
@includedir /etc/sudoers.d

# WSL 免密（开发环境）
leaf ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 "$TMP"

echo "=== 语法校验 ==="
if visudo -c -f "$TMP"; then
  cp /etc/sudoers "/etc/sudoers.bak.$(date +%Y%m%d%H%M%S)"
  install -m 0440 -o root -g root "$TMP" /etc/sudoers
  echo "已安装新 sudoers（旧文件已备份为 /etc/sudoers.bak.*）"
else
  echo "语法校验失败，未做修改"
  exit 1
fi
rm -f "$TMP"

echo "=== 验证 ==="
visudo -c
echo "--- leaf 免密 ---"
su - leaf -c 'sudo -n true && echo "leaf: sudo NOPASSWD OK"' 2>&1
echo "--- root 直连 ---"
sudo -n true && echo "root: sudo OK" || echo "root: sudo 仍不可用(非致命, root 本身即超级用户)"
echo "=== SUDOERS_FIX_DONE ==="
