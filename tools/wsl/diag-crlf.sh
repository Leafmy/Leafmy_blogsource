#!/usr/bin/env bash
cd "$HOME/projects/leafmy-top" || exit 1
echo "=== .gitattributes ==="
ls -la .gitattributes 2>/dev/null && cat .gitattributes || echo "(不存在)"
echo "=== check-attr ==="
git check-attr text eol -- _config.yml package.json 2>&1
echo "=== ls-files --eol (前 8) ==="
git ls-files --eol _config.yml package.json .gitignore | head -8
echo "=== 忽略行尾的真实改动数 ==="
git diff --ignore-cr-at-eol --numstat | wc -l
echo "=== 全部改动数 ==="
git status --porcelain | wc -l
echo "=== 未忽略行尾时, 单文件是否真差异 ==="
git diff --numstat -- _config.yml
git diff --ignore-cr-at-eol --numstat -- _config.yml
echo "=== .git/info/exclude ==="
cat .git/info/exclude 2>/dev/null | grep -v '^#' | grep -v '^$' || echo "(空)"
echo "=== core.autocrlf 生效值 ==="
git config --get core.autocrlf; git config --show-origin --get core.autocrlf
echo "=== 文件行尾 (ext4 副本) ==="
file _config.yml package.json
echo "=== DONE ==="
