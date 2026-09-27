#!/usr/bin/env bash
echo "=== NETWORK PROBE ==="
probe() { printf "%-46s " "$1"; curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 10 "$1" 2>&1 || echo "FAIL"; }
probe https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh
probe https://github.com/nvm-sh/nvm
probe https://gitee.com/mirrors/nvm
probe https://nodejs.org/dist/index.json
probe https://npmmirror.com/mirrors/node/index.json
probe https://registry.npmmirror.com/
probe https://registry.npmjs.org/
probe https://github.com/Leafmy/Leafmy_blogsource.git
echo "=== LATEST NVM TAG ==="
git ls-remote --tags --refs https://github.com/nvm-sh/nvm.git 2>/dev/null | awk -F/ '{print $NF}' | sort -V | tail -3
echo "=== LATEST NODE 22 FROM NPMMIRROR ==="
curl -s --max-time 15 https://npmmirror.com/mirrors/node/index.json 2>/dev/null | jq -r '[.[] | select(.version|startswith("v22."))][0].version' 2>/dev/null
echo "=== LATEST NODE 22 FROM NODEJS.ORG ==="
curl -s --max-time 15 https://nodejs.org/dist/index.json 2>/dev/null | jq -r '[.[] | select(.version|startswith("v22."))][0].version' 2>/dev/null
echo "=== DONE ==="
