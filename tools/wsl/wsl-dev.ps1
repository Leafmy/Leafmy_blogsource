<#
.SYNOPSIS
    WSL2 开发环境一键入口（Windows 侧）。

.DESCRIPTION
    把 leafmy-top 的 WSL2 原生开发副本接进日常工作流：
      code    —— 用 VS Code Remote-WSL 打开 WSL 原生项目（推荐日常使用）
      shell   —— 在 WSL 中打开项目目录的交互式 shell
      health  —— 运行 WSL 开发环境体检
      build   —— 在 WSL 中执行 hexo generate
      serve   —— 在 WSL 中启动 hexo server（4000 端口）
      clean   —— 在 WSL 中执行 hexo clean
      status  —— 对比 Windows 与 WSL 两侧的 git 状态
      push    —— 把 WSL 侧改动推送到 GitHub（含未提交改动提醒）

.EXAMPLE
    .\wsl-dev.ps1 code
    .\wsl-dev.ps1 health
    .\wsl-dev.ps1 serve
#>
[CmdletBinding()]
param(
    [ValidateSet('code', 'shell', 'health', 'build', 'serve', 'clean', 'status', 'push')]
    [string]$Action = 'code',

    [string]$Distro = 'Ubuntu-24.04',
    [string]$User = 'leaf',
    [string]$LinuxProject = '/home/leaf/projects/leafmy-top'
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:WSL_UTF8 = '1'

function Invoke-Wsl {
    param([string[]]$Argv)
    & wsl.exe -d $Distro -u $User -- @Argv
    if ($LASTEXITCODE -ne 0) { Write-Warning "WSL 命令返回码 $LASTEXITCODE" }
}

function Assert-WslReady {
    $null = & wsl.exe -d $Distro -u $User -- bash -lc 'true' 2>&1
    if ($LASTEXITCODE -ne 0) { throw "无法进入 WSL 发行版 $Distro，请先执行: wsl -d $Distro" }
}

Assert-WslReady

switch ($Action) {
    'code' {
        $linuxPath = (& wsl.exe -d $Distro -u $User -- bash -lc "cd $LinuxProject && pwd") -join '' -replace "`0", ''
        Write-Host "VS Code Remote-WSL -> $linuxPath" -ForegroundColor Cyan
        & code --remote "wsl+$Distro" $linuxPath
    }
    'shell' {
        Write-Host "进入 WSL shell: $LinuxProject" -ForegroundColor Cyan
        & wsl.exe -d $Distro -u $User --cd $LinuxProject
    }
    'health' {
        Invoke-Wsl @('bash', "$LinuxProject/tools/wsl/wslenv.sh")
    }
    'build' {
        Invoke-Wsl @('bash', '-lc', "cd $LinuxProject && export NVM_DIR=`$HOME/.nvm && . `$NVM_DIR/nvm.sh && npx hexo clean && npx hexo generate")
    }
    'serve' {
        Write-Host "hexo server 启动中，浏览器访问 http://localhost:4000" -ForegroundColor Cyan
        Invoke-Wsl @('bash', '-lc', "cd $LinuxProject && export NVM_DIR=`$HOME/.nvm && . `$NVM_DIR/nvm.sh && npx hexo server")
    }
    'clean' {
        Invoke-Wsl @('bash', '-lc', "cd $LinuxProject && export NVM_DIR=`$HOME/.nvm && . `$NVM_DIR/nvm.sh && npx hexo clean")
    }
    'status' {
        $win = (git -C (Join-Path $PSScriptRoot '..\..') status --porcelain) | Where-Object { $_ -notmatch '^\?\?' } | Sort-Object
        $wsl = (Invoke-Wsl @('bash', '-lc', "cd $LinuxProject && git status --porcelain")) | Where-Object { $_ -notmatch '^\?\?' } | Sort-Object
        Write-Host "`nWindows 侧修改/删除: $($win.Count)    WSL 侧: $($wsl.Count)" -ForegroundColor Cyan
        $diff = Compare-Object -ReferenceObject $win -DifferenceObject $wsl
        if ($diff) {
            Write-Host "两侧存在差异:" -ForegroundColor Yellow
            $diff | Format-Table -AutoSize
        }
        else {
            Write-Host "✅ 两侧工作区状态一致" -ForegroundColor Green
        }
    }
    'push' {
        Write-Host "从 WSL 侧推送到 origin/main" -ForegroundColor Cyan
        Invoke-Wsl @('bash', '-lc', "cd $LinuxProject && git status --short && git push origin main")
    }
}
