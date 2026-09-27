# WSL2 开发环境集成说明

本目录记录了把 `leafmy-top`（Hexo 7.3 博客）开发环境集成进 WSL2 的全过程、产出脚本与日常用法。

> 体检命令：`wsl -d Ubuntu-24.04 -u leaf -- bash -lc "~/projects/leafmy-top/tools/wsl/wslenv.sh"`

---

## 1. 环境基线（实测）

| 项目 | 值 |
| --- | --- |
| Windows | Windows 11 专业版 10.0.26200 |
| WSL | 2.7.14.0（内核 6.18.33.2-microsoft-standard-WSL2） |
| 发行版 | Ubuntu 24.04.5 LTS（`Ubuntu-24.04`，WSL2 模式，默认发行版） |
| 用户 | `leaf` (uid 1000)，`sudo` 免密 |
| 资源 | 20 核 / 7.6 GiB 内存 / 根分区可用 954 G |
| 时区 | `Asia/Shanghai` (CST) |
| apt 源 | 清华 TUNA 镜像 |
| Node | **v22.23.3**（nvm v0.40.3，`default -> 22`） |
| 包管理器 | npm 10.9.9、pnpm 12.6.0 |
| npm 源 | `https://registry.npmmirror.com` + node/electron/sharp 等二进制镜像 |
| 其他工具 | git 2.43.0、python3 3.12.3、pip3 24.0、gcc/g++ 13.3.0、make 4.3、jq、ripgrep、fd、fzf、tmux、sqlite3、dos2unix、rsync、unzip |
| Git 身份 | 关小叶 / 2994832083@qq.com |
| GitHub | SSH `id_ed25519`（自 Windows 复制），`ssh -T git@github.com` 认证通过 |
| 项目路径 | `/home/leaf/projects/leafmy-top`（WSL 原生 ext4） |
| 构建验证 | `hexo generate` → 99 个文件 / 约 610 ms |

---

## 2. 本次修复的环境缺陷

迁移过程中发现并修复了 6 个既有问题：

| # | 问题 | 影响 | 处理 |
| --- | --- | --- | --- |
| 1 | `apt install` 因 `/etc/sudoers` conffile 交互提示中断，dpkg 处于半配置状态 | 后续所有 `apt` 操作失败 | `dpkg --force-confold --configure -a` 修复，并写入 `/etc/apt/apt.conf.d/99dsh-noninteractive` 永久非交互 |
| 2 | `/etc/sudoers` 被替换为仅 28 字节的精简文件（只有一行 `leaf ALL=(ALL) NOPASSWD:ALL`） | 缺 `root` 条目、`@includedir /etc/sudoers.d`、`secure_path`，`sudoers.d` 派发全部失效 | 恢复完整 sudoers（保留 leaf 免密），旧文件备份为 `/etc/sudoers.bak.*` |
| 3 | 时区为 UTC | 构建时间戳、文章日期偏移 8 小时 | 设为 `Asia/Shanghai` |
| 4 | Windows 侧 DSH Desktop 的 `node` 目录被注入 WSL `PATH`（且排在 `/usr/bin` 前） | WSL 里执行 `node` 会命中 Windows 二进制并报 `This: command not found` | 在 `~/.bashrc` 中按模式剔除 `/mnt/*/node/bin` 与 `/mnt/*/.desktop-bin` |
| 5 | 上述 `~/.bashrc` 配置块被写在「非交互即 `return`」守卫**之后** | `bash -lc '...'`、ssh 远程命令等非交互登录 shell 完全拿不到 node/npm | 把配置块移到守卫之前（`fix-bashrc.sh`） |
| 6 | 项目 `.git/config` 残留 `http.proxy = http://127.0.0.1:7890` 与 Windows 专用 `core.sshCommand` | WSL 中 git 走一个**并不存在**的代理（Windows 侧 7890 无监听），所有远端操作失败 | 在 WSL 副本中清除这些键；实测直连 GitHub 仅需 ~1.3 s |

> ⚠️ **行尾陷阱（重要）**：仓库中存储的是 LF，而 Windows 工作区文件是 CRLF。WSL 里 `core.autocrlf=false` 会把 266 个文件全部报成「已修改」，制造出 285 处假改动（真实改动只有 23 处）。
> 处理方式：WSL 侧设 `core.autocrlf=input`，并把工作区文本文件归一化为 LF。**不要对二进制文件做行尾转换** —— `dos2unix -f` 会强行转换二进制，本次曾损坏 12 个 `.woff2/.png/.jpg/.gif`（已从源完整还原并逐字节校验）。脚本中一律使用 `grep -I` 判定文本后再 `sed`，或 `dos2unix`（不加 `-f`）。

---

## 3. 迁移策略

| 内容 | 处理 | 原因 |
| --- | --- | --- |
| `.git` 与历史 | 从本地 Windows 路径 `git clone --no-hardlinks` | 不走网络；保留完整提交历史 |
| 工作区（含 23 处未提交修改 + 12 处未跟踪） | `rsync -a` 逐字节同步 | 未提交的工作不能丢；已用 rsync checksum 校验一致 |
| `node_modules/` | **不迁移**，在 WSL 重新 `npm ci` | Windows 版含 `.cmd`/`.ps1` shim 与 win32 原生模块，Linux 不可用 |
| `public/` | 不迁移，重新生成 | 构建产物，平台无关但应重建 |
| `.perf/`（803 MB） | **不迁移** | 本地临时产物：Chrome profile、截图、ffx 工具、性能探针 |
| 文本文件行尾 | 归一化为 LF | Linux 侧正确约定；git 提交时本就统一存 LF，故两端提交内容一致 |
| 二进制文件 | 保持原样并逐字节校验 | 见上文行尾陷阱 |

迁移后两端 git 状态核对：**Windows 23 处修改/删除 ↔ WSL 23 处，完全一致**（WSL 少 `.perf/` 这一个未跟踪目录）。

---

## 4. 两侧仓库的同步模型

Windows 副本（`C:\Users\Leaf_\Desktop\All In\leafmy-top`）与 WSL 副本（`~/projects/leafmy-top`）是**同一仓库的两份检出**：

```
        ┌──────────────────────────┐
        │  GitHub  Leafmy_blogsource │
        └───────▲──────────┬───────┘
                │ push     │ pull
    ┌───────────┴──┐   ┌───▼──────────────────┐
    │ Windows 副本  │   │ WSL 副本 (ext4, 快)   │
    │ /mnt/c/...   │   │ ~/projects/leafmy-top │
    └──────────────┘   └──────────────────────┘
```

- **用 git 同步，不要用 rsync 互推** —— 两侧行尾不同，rsync 会把 CRLF 推回去，重新制造 266 处假改动。
- 推荐把 WSL 作为主力开发环境（ext4 上 `npm ci` 4 秒、`hexo generate` 0.6 秒），Windows 副本保留作备份/应急。
- 切记：**当前有 23 处未提交改动**，在任一侧切换工作前先 `git status` 确认，必要时先提交或 stash。

---

## 5. 日常使用

### 5.1 推荐：VS Code Remote-WSL

已安装扩展 `ms-vscode-remote.remote-wsl` v0.104.3。

```powershell
# 从 Windows 一键打开（项目根目录执行）
.\tools\wsl\wsl-dev.cmd code
```

或手动：VS Code → `F1` → `WSL: Connect to WSL` → 打开 `/home/leaf/projects/leafmy-top`。
也可直接访问 UNC 路径：`\\wsl$\Ubuntu-24.04\home\leaf\projects\leafmy-top`（已验证可达）。

WSL 副本内已生成 `.vscode/`：

- `settings.json` —— `files.eol: \n`、排除 `node_modules/public/.perf` 的搜索与监听
- `tasks.json` —— `hexo: clean` / `hexo: generate`(默认构建) / `hexo: server` / `hexo: 清理并重建`
- `extensions.json` —— 推荐扩展（Markdown、GitLens、YAML 等）

> 注意：Remote-WSL 下扩展需在 WSL 侧安装（UI 类扩展除外）。首次连接时 VS Code 会提示安装推荐扩展。

### 5.2 Windows 侧入口脚本

```powershell
.\tools\wsl\wsl-dev.cmd code     # VS Code Remote-WSL 打开项目
.\tools\wsl\wsl-dev.cmd shell    # 在项目目录开 WSL 交互 shell
.\tools\wsl\wsl-dev.cmd health   # 环境体检
.\tools\wsl\wsl-dev.cmd build    # hexo clean + generate
.\tools\wsl\wsl-dev.cmd serve    # hexo server（http://localhost:4000）
.\tools\wsl\wsl-dev.cmd clean    # hexo clean
.\tools\wsl\wsl-dev.cmd status   # 对比 Windows/WSL 两侧 git 状态
.\tools\wsl\wsl-dev.cmd push     # 从 WSL 侧推送 origin/main
```

> 本机执行策略为默认的 `Restricted`，直接运行 `.ps1` 会被拦截。`wsl-dev.cmd` 是包装器，
> 内部用 `powershell.exe -ExecutionPolicy Bypass -File` 调用 `wsl-dev.ps1`，
> **只对该次进程生效，不修改系统或用户的执行策略**。
>
> 若你更愿意直接跑 `.ps1`：`powershell -ExecutionPolicy Bypass -File .\tools\wsl\wsl-dev.ps1 health`。
> 另外本机只装了 Windows PowerShell 5.1（无 `pwsh`），`wsl-dev.ps1` 已按 5.1 语法编写并带 UTF-8 BOM（5.1 读取无 BOM 的 UTF-8 中文会解析失败）。

### 5.3 直接在 WSL 里工作

```bash
wsl -d Ubuntu-24.04 -u leaf --cd ~/projects/leafmy-top

cd ~/projects/leafmy-top
npx hexo clean && npx hexo generate   # 构建
npx hexo server                       # 本地预览 http://localhost:4000
npx hexo deploy                       # 部署（需先配置好凭证）
nvm install 24 && nvm use 24          # 需要时切换 Node 版本
```

`~/.bashrc` 已保证交互式与非交互登录 shell 都能拿到 Node，无需手动 `nvm use`。

---

## 6. 脚本清单

| 脚本 | 运行身份 | 作用 |
| --- | --- | --- |
| `detect.sh` / `detect2.sh` | leaf | 环境基线检测（系统、工具链、PATH、项目） |
| `probe-net.sh` / `probe-gitnet.sh` / `probe-repo.sh` / `probe-proxy-diff.sh` | leaf | 网络、镜像、仓库可见性、代理来源探测 |
| `measure-src.sh` | leaf | 源目录体积分布 |
| `install-base.sh` | leaf | apt 安装基础工具链 |
| `fix-dpkg.sh` | **root** | 修复 dpkg 中断 + 非交互 apt + 时区 |
| `fix-sudoers.sh` | **root** | 恢复完整 `/etc/sudoers` |
| `install-node.sh` | leaf | nvm + Node 22 LTS + pnpm + 镜像 + `.bashrc` 配置块 |
| `fix-bashrc.sh` | leaf | 把配置块移到 `.bashrc` 守卫之前 |
| `setup-user-env.sh` | leaf | `.npmrc` 镜像、全局 git 配置、SSH 密钥接入 |
| `setup-project.sh` / `finalize-project.sh` | leaf | 克隆到 `~/projects`、对齐工作区、`npm ci`、构建验证 |
| `repair-eol.sh` | leaf | 还原被误伤的二进制文件 + 仅对文本做 LF 归一化 |
| `finalize-integration.sh` | leaf | VS Code 工作区配置 + 脚本同步 + 最终体检 |
| `verify-parity.sh` / `diag-*.sh` | leaf | 两端一致性、CRLF、`bashrc` 结构诊断 |
| `wslenv.sh` | leaf | **环境体检（日常最常用）** |
| `wsl-dev.cmd` / `wsl-dev.ps1` | Windows | **一键入口（日常最常用）**，`.cmd` 为绕过执行策略的包装器 |
| `verify-final.sh` | leaf | 同步脚本 + 端到端构建 + 两端一致性最终验证 |
| `README.md` | — | 本文档 |

---

## 7. 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `node: This: command not found` | 命中了 PATH 里的 Windows node | 确认 `~/.bashrc` 的 `wsl-dev-env` 块存在且位于 `case $- in` 之前；执行 `fix-bashrc.sh` |
| `node: command not found`（`bash -lc` 里） | nvm 未加载 | 同上；脚本内可显式 `. ~/.nvm/nvm.sh` |
| WSL 里 git 报 `Failed to connect to 127.0.0.1 port 7890` | 仓库 `.git/config` 残留失效代理 | `git config --unset http.proxy; git config --unset https.proxy` |
| `git status` 出现几百处改动 | WSL 侧 `core.autocrlf=false` 把 CRLF 当改动 | `git config core.autocrlf input`，并按 `repair-eol.sh` 的方式归一化文本 |
| 构建产物缺少字体/图片 | 二进制文件被行尾工具破坏 | 用 `rsync -rcn` 对比源；**不要用 `dos2unix -f`** |
| `sudo` 报 `root is not in the sudoers file` | 用 `sudo` 而非 `wsl -u root` 提权 | 直接用 `wsl -d Ubuntu-24.04 -u root -- ...` |
| 运行 `wsl-dev.ps1` 报 "running scripts is disabled" | 执行策略为默认 `Restricted` | 用 `wsl-dev.cmd`，或 `powershell -ExecutionPolicy Bypass -File ...` |
| 编辑 `wsl-dev.ps1` 后报成片的语法错误 | PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文破坏解析 | 保存为 **UTF-8 with BOM**：`[IO.File]::WriteAllText($p,$t,[Text.UTF8Encoding]::new($true))` |

---

## 8. 可选增强（未执行，按需自取）

### 启用 systemd
当前 init 不是 systemd（`[boot]` 段为空）。若需要 `systemctl` / 常驻服务：

```bash
# 以 root 在 /etc/wsl.conf 追加：
[boot]
systemd=true
```
之后在 Windows 执行 `wsl --shutdown` 使其生效（会终止当前 WSL 会话）。

### Docker
若需容器化，推荐安装 Windows 版 Docker Desktop 并启用其 WSL 集成（不要与发行版内的 docker-ce 并存）。

### 磁盘占用
WSL 根分区已用约 1 GB；如需回收，Windows 侧执行 `wsl --manage Ubuntu-24.04 --set-sparse true` 或 `Optimize-VHD`。
