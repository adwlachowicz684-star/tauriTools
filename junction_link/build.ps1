# 分配项目组 (C# WPF) - 一键编译脚本
# 用法: powershell -ExecutionPolicy Bypass -File build.ps1 [-Clean]
# 输出: ..\dist\分配项目组.exe (连同运行时依赖)
#
# AI 提示: AI 修改 src/ 下的 .cs/.xaml 后，调用本脚本重新编译出 dist/ 的 exe。
# 本脚本自动探测 .NET SDK（PATH / VS 私有 SDK），找不到时给出安装指引，不会半途失败。

[CmdletBinding()]
param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot     # build.ps1 就在项目根，PSScriptRoot 即项目目录
$src  = Join-Path $root 'src'
$out  = Join-Path $root 'dist'

# 关键：本目录含中文。外部 `powershell -File` 启动的 dotnet.exe 子进程若收到
# 中文路径参数会被按 GBK 编码破坏（PS 5.1 已知坑）。
# 规避：Set-Location 到项目（进程内 cwd，UTF-16 无损），随后统一用英文相对路径
# 给 dotnet；构建中间产物放到英文 TEMP，最后用 PowerShell 自身把 exe 拷回 dist。
Set-Location -LiteralPath $root

# 英文中间目录（TEMP 通常为 ASCII）
$tmpBase = Join-Path $env:TEMP 'fpx-migration-build'
$objDir  = Join-Path $tmpBase 'obj'
$binDir  = Join-Path $tmpBase 'bin'
$pubDir  = Join-Path $tmpBase 'publish'
foreach ($d in @($objDir, $binDir, $pubDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
# csproj 相对路径（全英文）
$proj = Join-Path 'src' 'FenPeiXiangMuZu.csproj'

# ---- 1. 探测可用的 dotnet SDK ----
# 注意：PS5.1 + $ErrorActionPreference='Stop' 时，原生命令 stderr 输出经 2>$null 重定向会包装成
# ErrorRecord 直接终止脚本（NativeCommandError）。SDK 探测与编译调用期间临时降级为 Continue。
$eapPrev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
# 验证某 dotnet 是否真有 SDK（--list-sdks 成功且退出码为 0）；输出全部丢弃避免污染控制台
function Test-DotNetSdk([string]$path) {
    if ([string]::IsNullOrEmpty($path) -or -not (Test-Path $path)) { return $false }
    & $path --list-sdks *> $null
    return ($LASTEXITCODE -eq 0)
}
function Find-DotNet {
    # vswhere 探测（覆盖任意 VS 版本/ editions，不再硬编码 VS2022 Community）
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vsPath = & $vswhere -latest -products * -requires Microsoft.DotNet.DesktopSDK -property installationPath 2>$null
        if ($vsPath) {
            $candidate = Join-Path $vsPath 'dotnet\dotnet.exe'
            if (Test-DotNetSdk $candidate) { return $candidate }
        }
    }

    # 用户目录 SDK（dotnet-install.ps1 默认/指定装到这里）
    $userDotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
    if (Test-DotNetSdk $userDotnet) { return $userDotnet }

    # 环境 PATH（可能只有运行时没有 SDK，须验证）
    $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($cmd -and (Test-DotNetSdk $cmd.Source)) { return $cmd.Source }

    return $null
}

$dotnet = Find-DotNet
if (-not $dotnet) {
    Write-Host @"

[!] 未检测到 .NET SDK 编译器。
    首次编译前需要其一：
      1) 安装 .NET 8 SDK:   https://dotnet.microsoft.com/download/dotnet/8.0
      2) 或打开 VS Installer，给 "Visual Studio Community 2022" 添加
         ".NET 桌面开发" 工作负载（会自动装 SDK）。
    装好后重跑本脚本即可。
"@ -ForegroundColor Yellow
    exit 1
}

Write-Host "使用 SDK: $dotnet" -ForegroundColor Cyan
$dotnet = (Resolve-Path $dotnet).Path

# ---- 2. 编译 ----
Write-Host "开始编译 (publish)…" -ForegroundColor Green
# 中间产物路径已下沉到各 csproj（英文 TEMP，独立子目录），此处级联清理以免 wpftmp 残留相互污染
$kityObjBase = Join-Path $env:TEMP 'fpx-kityminder-plugin-build'
foreach ($p in @($tmpBase, $kityObjBase)) {
    Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
}
foreach ($d in @($objDir, $binDir, $pubDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# WPF 标记编译器会在项目目录生成临时 wpftmp 工程（src\obj），残留会导致 CS0579 特性重复；
# 每次编译前清理 src\obj / src\bin 避免累积冲突。
Remove-Item -Recurse -Force (Join-Path $src 'obj') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $src 'bin') -ErrorAction SilentlyContinue

& $dotnet publish $proj -c Release -f net8.0-windows -r win-x64 --self-contained false -o $pubDir
if ($LASTEXITCODE -ne 0) { Write-Host "编译失败（exit=$LASTEXITCODE）" -ForegroundColor Red; exit $LASTEXITCODE }

# ---- 3. 拷贝产物到 dist（PowerShell 自身处理中文路径，不经过 dotnet 子进程）----
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $pubDir -File | Copy-Item -Destination $out -Force

# 恢复严格模式
$ErrorActionPreference = $eapPrev

$exe = Join-Path $out '分配项目组.exe'
if (Test-Path $exe) {
    Write-Host "编译成功: $exe" -ForegroundColor Green
    # 成功后清理英文 TEMP 中间产物，避免累积占用磁盘
    Remove-Item -Recurse -Force $tmpBase -ErrorAction SilentlyContinue
} else {
    Write-Host "警告: 未找到 exe（可能仅生成了 dll）" -ForegroundColor Yellow
}