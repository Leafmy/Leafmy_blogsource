#!/usr/bin/env bash
echo "=== Windows 宿主 IP ==="
HOST_IP=$(ip route show default | awk '{print $3}')
echo "default gateway (Windows host) = $HOST_IP"
grep -m1 nameserver /etc/resolv.conf
echo "=== 代理 7890 在 Windows 宿主上是否可达 ==="
curl -s -o /dev/null -w "http://$HOST_IP:7890 -> %{http_code} (%{time_total}s)\n" --max-time 6 -x "http://$HOST_IP:7890" https://github.com 2>&1 || echo "proxy FAIL"
echo "=== 直连 github.com (HTTPS/git, 无代理) ==="
timeout 20 env -u http_proxy -u https_proxy GIT_TERMINAL_PROMPT=0 \
  git -c http.proxy= -c https.proxy= ls-remote --heads https://github.com/Leafmy/Leafmy_blogsource.git 2>&1 | head -3
echo "--- 耗时测试 ---"
time (timeout 25 env GIT_TERMINAL_PROMPT=0 git -c http.proxy= -c https.proxy= ls-remote https://github.com/Leafmy/Leafmy_blogsource.git >/dev/null 2>&1) 2>&1 | tail -4

echo "=== SSH github.com:22 ==="
timeout 12 bash -c 'exec 3<>/dev/tcp/github.com/22 && head -1 <&3' 2>&1 || echo "port 22 FAIL"
echo "=== SSH ssh.github.com:443 ==="
timeout 12 bash -c 'exec 3<>/dev/tcp/ssh.github.com/443 && head -1 <&3' 2>&1 || echo "port 443 FAIL"

echo "=== .npmrc 当前内容 ==="
cat "$HOME/.npmrc" 2>/dev/null || echo "(无)"
echo "=== DONE ==="
