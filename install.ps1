# qq-bridge × WorkBuddy 后端扩展 · 安装入口（Windows）
#
# 先把原版 qq-bridge 下载到本机（git clone 或 Release zip 解压），
# 然后在本扩展包目录运行：.\install.ps1
# 安装向导会让你指定 qq-bridge 目录，之后自动备份/打补丁/配置/自检/启动。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  qq-bridge × WorkBuddy 后端扩展 安装器" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

function Fail($msg) {
  Write-Host "✘ $msg" -ForegroundColor Red
  exit 1
}

# 1) Node.js
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail "找不到 Node.js。请先安装 Node.js 22+：https://nodejs.org/" }
$version = (& node --version).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt 22) { Fail "Node.js 版本过低（$version），需要 22 或更高。" }
Write-Host "✔ Node.js $version" -ForegroundColor Green

# 2) npm
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { Fail "找不到 npm（通常随 Node.js 一起安装）。" }
Write-Host "✔ npm $((& npm --version))" -ForegroundColor Green
Write-Host ""

# 3) 运行扩展安装器
& node "$root\payload\scripts\setup-apply.mjs" @args
exit $LASTEXITCODE
