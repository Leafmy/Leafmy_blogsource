#!/usr/bin/env bash
# 收尾：VS Code 工作区配置 + 脚本同步 + 最终体检
set -uo pipefail
SRC="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
DST="$HOME/projects/leafmy-top"
cd "$DST" || exit 1

echo "############ [1/4] VS Code 工作区配置 ############"
mkdir -p .vscode

cat > .vscode/settings.json <<'EOF'
{
  "// WSL2 原生开发副本的工作区设置": "",
  "files.eol": "\n",
  "files.encoding": "utf8",
  "files.autoGuessEncoding": false,
  "files.trimTrailingWhitespace": false,
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
  "editor.rulers": [100],
  "search.exclude": {
    "**/node_modules": true,
    "**/public": true,
    "**/.perf": true,
    "**/package-lock.json": true,
    "**/db.json": true
  },
  "files.watcherExclude": {
    "**/node_modules/**": true,
    "**/public/**": true,
    "**/.perf/**": true
  },
  "terminal.integrated.defaultProfile.linux": "bash",
  "terminal.integrated.cwd": "${workspaceFolder}",
  "git.autofetch": true,
  "git.confirmSync": false,
  "git.enableSmartCommit": true,
  "explorer.fileNesting.enabled": true,
  "explorer.fileNesting.patterns": {
    "package.json": "package-lock.json,.npmrc",
    "_config.yml": "_config.*.yml"
  }
}
EOF

cat > .vscode/tasks.json <<'EOF'
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "hexo: clean",
      "type": "shell",
      "command": "npx hexo clean",
      "problemMatcher": []
    },
    {
      "label": "hexo: generate",
      "type": "shell",
      "command": "npx hexo generate",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": []
    },
    {
      "label": "hexo: server",
      "type": "shell",
      "command": "npx hexo server",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated" }
    },
    {
      "label": "hexo: 清理并重建",
      "type": "shell",
      "command": "npx hexo clean && npx hexo generate",
      "problemMatcher": []
    }
  ]
}
EOF

cat > .vscode/extensions.json <<'EOF'
{
  "recommendations": [
    "yzhang.markdown-all-in-one",
    "bierner.markdown-preview-github-styles",
    "eamodio.gitlens",
    "mhutchie.git-graph",
    "editorconfig.editorconfig",
    "redhat.vscode-yaml"
  ]
}
EOF

echo "已写入:"; ls -la .vscode/

echo "############ [2/4] 同步 tools/wsl 脚本到 WSL 副本 ############"
mkdir -p tools/wsl
cp -f "$SRC"/tools/wsl/*.sh "$SRC"/tools/wsl/*.ps1 tools/wsl/ 2>/dev/null
# 确保 shell 脚本为 LF 且可执行（CRLF 会导致 bash 报错）
for f in tools/wsl/*.sh; do
  [ -f "$f" ] || continue
  sed -i 's/\r$//' "$f"; chmod +x "$f"
done
ls -la tools/wsl/ | head -25

echo "############ [3/4] 确认 .vscode 不污染 git 状态 ############"
git status --porcelain | grep -E '\.vscode|tools/wsl' | head -5
echo "(tools/ 与 .vscode/ 均为未跟踪的新增开发配置)"

echo "############ [4/4] 最终体检 ############"
bash tools/wsl/wslenv.sh
echo "### INTEGRATION_DONE"
