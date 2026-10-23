# qq-bridge × WorkBuddy 后端扩展 · 卸载入口（Windows）
# 恢复 src/bridge.js 备份，删除扩展新增文件（不动 config.json 与登录态）。
# 用法：.\uninstall.ps1 [-target <qq-bridge 目录>]

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

& node "$root\payload\scripts\setup-apply.mjs" --uninstall @args
exit $LASTEXITCODE
