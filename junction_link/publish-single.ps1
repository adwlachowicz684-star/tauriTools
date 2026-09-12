# 分配项目组 (C# WPF) - 单文件发布脚本
# 用法: powershell -ExecutionPolicy Bypass -File publish-single.ps1
# 输出: ..\dist\single\分配项目组.exe （框架依赖 + PublishSingleFile 单文件）
#
# AI 提示: 需要把成品发给无 SDK 的机器时用本脚本；本机运行用 build.ps1 即可（多文件更快）。
# 与 build.ps1 同构处理中文目录：Set-Location + 相对参数 + 中间产物放英文 TEMP。

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location -LiteralPath $root

$tmpBase = Join-Path $env:TEMP 'fpx-migration-publish-single'
$objDir  = Join-Path $tmpBase 'obj'
$binDir  = Join-Path $tmpBase 'bin'
$pubDir  = Join-Path $tmpBase 'publish'
foreach ($d in @($objDir, $binDir, $pubDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
$proj = Join-Path 'src' 'FenPeiXiangMuZu.csproj'
$out  = Join-Path $root 'dist\single'

function Test-DotNetSdk([string]$path) {
    if ([string]::IsNullOrEmpty($path) -or -not (Test-Path $path)) { return $false }
    & $path --list-sdks *> $null
    return ($LASTEXITCODE -eq 0)
}

function Find-DotNet {
    # vswhere 探测（覆盖任意 VS 版本，不再硬编码 VS2022 Community）
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vsPath = & $vswhere -latest -products * -requires Microsoft.DotNet.DesktopSDK -property installationPath 2>$null
        if ($vsPath) {
            $candidate = Join-Path $vsPath 'dotnet\dotnet.exe'
            if (Test-DotNetSdk $candidate) { return $candidate }
        }
    }
    $userDotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
    if (Test-DotNetSdk $userDotnet) { return $userDotnet }
    $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($cmd -and (Test-DotNetSdk $cmd.Source)) { return $cmd.Source }
    return $null
}

# dotnet 调用段临时降级 EAP：PS5.1 下原生命令 stderr 输出会以 ErrorRecord 终止脚本
$eapPrev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

$dotnet = Find-DotNet
if (-not $dotnet) {
    Write-Host "[!] 未检测到 .NET SDK。请先运行 build.ps1 查看安装指引。" -ForegroundColor Yellow
    exit 1
}
$dotnet = (Resolve-Path $dotnet).Path
Write-Host "使用 SDK: $dotnet" -ForegroundColor Cyan

# 注意：不得用 -p:BaseIntermediateOutputPath/-p:IntermediateOutputPath/-p:BaseOutputPath/-p:OutputPath
# 全局覆盖中间输出路径——-p 全局属性优先级高于 src/Directory.Build.props，会把 KityMinderPlugin
# 也挤到主工程同一 obj 目录，破坏两工程隔离(WPFTMP/.g.cs 撞车)，导致 WebView2 标记编译失败(MC3074)。
# 中间/输出路径统一交由 src/Directory.Build.props 与 KityMinderPlugin/Directory.Build.props 各自设定。
Write-Host "单文件发布 (win-x64, 框架依赖)…" -ForegroundColor Green
& $dotnet publish $proj -c Release -f net8.0-windows -r win-x64 --self-contained false `
    -o $pubDir `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:PublishReadyToRun=false `
    -p:EnableCompressionInSingleFile=false
if ($LASTEXITCODE -ne 0) { Write-Host "发布失败（exit=$LASTEXITCODE）" -ForegroundColor Red; exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $pubDir -File | Copy-Item -Destination $out -Force

# 恢复严格模式
$ErrorActionPreference = $eapPrev

$exe = Join-Path $out '分配项目组.exe'
if (Test-Path $exe) {
    $sz = (Get-Item $exe).Length / 1MB
    Write-Host ("单文件发布成功: $exe  ({0:N1} MB)" -f $sz) -ForegroundColor Green
    # 成功后清理英文 TEMP 中间产物
    Remove-Item -Recurse -Force $tmpBase -ErrorAction SilentlyContinue
} else {
    Write-Host "警告: 未找到单文件 exe（发布包在 $pubDir）" -ForegroundColor Yellow
}