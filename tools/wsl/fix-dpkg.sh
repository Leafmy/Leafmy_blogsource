#!/usr/bin/env bash
# 以 root 运行：修复 dpkg 中断状态 + 非交互 apt 配置 + 时区
set -uo pipefail

echo "### [1/5] 让 apt/dpkg 永久非交互"
cat > /etc/apt/apt.conf.d/99dsh-noninteractive <<'EOF'
Dpkg::Options { "--force-confdef"; "--force-confold"; }
APT::Get::Assume-Yes "true";
APT::Get::Allow-Downgrades "true";
DPkg::Lock::Timeout "120";
EOF
echo 'tzdata tzdata/Areas select Asia' | debconf-set-selections
echo 'tzdata tzdata/Zones/Asia select Shanghai' | debconf-set-selections
export DEBIAN_FRONTEND=noninteractive

echo "### [2/5] 修复 sudo 包 (保留现有 sudoers)"
dpkg --force-confold --configure sudo 2>&1 | tail -5

echo "### [3/5] 完成所有待配置包"
dpkg --force-confold --configure -a 2>&1 | tail -15
echo "--- dpkg audit ---"
dpkg --audit 2>&1 | head -20
echo "(空 = 无损坏包)"

echo "### [4/5] 时区 -> Asia/Shanghai"
ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
echo "Asia/Shanghai" > /etc/timezone
dpkg-reconfigure -f noninteractive tzdata >/dev/null 2>&1
date

echo "### [5/5] 验证 sudo 与包状态"
sudo -n true 2>/dev/null && echo "sudo: OK (passwordless)" || echo "sudo: FAIL"
dpkg -l sudo | tail -1
echo "### FIX_DONE"
