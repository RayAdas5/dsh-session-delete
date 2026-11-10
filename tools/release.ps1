# 一次改动走完「升版本 → 提交 → 推到 GitHub」
#
# 用法（在 DSH 外的终端里）：
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Level patch -Message "修复 xxx"
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Level minor -Message "新增 xxx"
#
# -Level 对应改动程度：patch 修 bug / minor 新功能 / major 破坏兼容
# -Message 一句话说明，会同时写进 CHANGELOG 和 commit message
#
# 代理会自动探测（Clash 默认 7897），找不到就走直连。

param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Level = 'patch',
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$repo = Join-Path $PSScriptRoot '..'
Set-Location $repo

$node = 'C:\Users\19393\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

if ($Message -eq '') {
    Write-Host '缺少 -Message：一句话说明这次改了什么' -ForegroundColor Red
    exit 1
}

# 1) 升版本 + 补 CHANGELOG
& $node tools/bump.mjs $Level $Message
if ($LASTEXITCODE -ne 0) { exit 1 }

$version = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version

# 2) 提交
git add -A
if ($LASTEXITCODE -ne 0) { exit 1 }
git commit -m "v${version}: $Message"
if ($LASTEXITCODE -ne 0) {
    Write-Host '提交失败（可能没有改动，或 git 身份没配）' -ForegroundColor Red
    exit 1
}

# 3) 探测代理并推送
$proxy = $null
foreach ($port in @(7897, 7890, 7899, 7898, 1080, 10809)) {
    $line = netstat -ano | Select-String ":$port .*LISTENING" | Select-Object -First 1
    if ($line) { $proxy = "http://127.0.0.1:$port"; break }
}

if ($proxy) {
    Write-Host "走代理 $proxy 推送…" -ForegroundColor Cyan
    git -c "http.proxy=$proxy" -c "https.proxy=$proxy" push
} else {
    Write-Host '没探测到本地代理，尝试直连…' -ForegroundColor Yellow
    git push
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n已发布 v$version：https://github.com/RayAdas5/dsh-session-delete" -ForegroundColor Green
} else {
    Write-Host "`nv$version 已提交到本地，但推送失败——检查代理或网络后重跑：" -ForegroundColor Red
    Write-Host "  git push"
    exit 1
}
