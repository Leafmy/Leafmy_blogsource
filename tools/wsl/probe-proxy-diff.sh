#!/usr/bin/env bash
echo "=== 代理来源排查 ==="
echo "--- 环境变量 ---"
env | grep -iE 'proxy|PROXY' || echo "(无 proxy 环境变量)"
echo "--- /etc/environment ---"
cat /etc/environment 2>/dev/null || echo "(无)"
echo "--- ~/.gitconfig ---"
cat "$HOME/.gitconfig" 2>/dev/null || echo "(无)"
echo "--- /etc/gitconfig ---"
cat /etc/gitconfig 2>/dev/null || echo "(无)"
echo "--- git 生效的 proxy 配置 ---"
git config --show-origin --get-regexp 'proxy' 2>/dev/null || echo "(git 无 proxy 配置)"
echo "--- wsl.conf ---"
cat /etc/wsl.conf 2>/dev/null
echo "--- profile.d 里的 proxy ---"
grep -rliE 'proxy' /etc/profile.d/ /etc/profile 2>/dev/null || echo "(无)"

echo ""
echo "=== Windows 项目 285 个改动性质分析 ==="
P="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
echo "--- diff --stat 前 10 行 ---"
git -C "$P" -c core.autocrlf=false diff --stat 2>/dev/null | tail -12
echo "--- 忽略行尾差异后的改动数 ---"
git -C "$P" -c core.autocrlf=false diff --numstat 2>/dev/null | awk '{a+=$1;d+=$2} END{print "insertions="a" deletions="d}'
echo "--- 单文件行尾检测 (_config.yml) ---"
file "$P/_config.yml"
head -c 200 "$P/_config.yml" | od -c | grep -m2 '\\r' && echo "含 CRLF" || echo "纯 LF"
echo "--- git 视角: 该文件差异前 15 行 ---"
git -C "$P" -c core.autocrlf=false diff -- _config.yml 2>/dev/null | head -15
echo "--- core.autocrlf (WSL git 默认) ---"
git config --get core.autocrlf || echo "(未设置 = false)"
echo "--- Windows 侧 autocrlf ---"
echo "Windows 侧为 input (见 Windows git config)"
echo "=== DONE ==="
