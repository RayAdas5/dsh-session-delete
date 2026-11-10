# 把插件仓库推到 GitHub（自动探测 Clash / 常见代理端口）
#
# 用法：在【DSH 之外】的终端里运行
#   powershell -ExecutionPolicy Bypass -File "C:\Users\19393\Documents\deepseek-harness\default-workspace\dsh-session-delete\tools\push.ps1"
#
# 前提：代理软件（Clash Verge 等）已经启动，并且系统代理或混合端口在监听。
# 首次推送会弹 Git Credential Manager 的浏览器登录窗口，登录一次即可。

$ErrorActionPreference = 'Stop'
$repo = Join-Path $PSScriptRoot '..'
Set-Location $repo

# Clash Verge 的混合端口默认 7897；常见备选 7890 / 7899 / 1080 / 10809
$candidates = @(7897, 7890, 7899, 7898, 1080, 10809)
$proxy = $null
foreach ($port in $candidates) {
    $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($ok) {
        $proxy = "http://127.0.0.1:$port"
        break
    }
}

if ($proxy) {
    Write-Host "检测到代理：$proxy" -ForegroundColor Green
} else {
    Write-Host "没检测到本地代理端口，先试直连（大概率会失败）。" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '正在推送…（首次会弹 GitHub 登录窗口）' -ForegroundColor Cyan

if ($proxy) {
    git -c "http.proxy=$proxy" -c "https.proxy=$proxy" push -u origin main
} else {
    git push -u origin main
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ''
    Write-Host '推送成功。' -ForegroundColor Green
    git ls-remote --heads origin
} else {
    Write-Host ''
    Write-Host '推送失败。常见原因：' -ForegroundColor Red
    Write-Host '  1. 代理没开 / 端口不对 —— 换个端口再试：-c http.proxy=http://127.0.0.1:7890'
    Write-Host '  2. GitHub 连不上 —— 先确认浏览器能打开 github.com'
    Write-Host '  3. 认证被拒 —— 删掉凭据重试：cmdkey /delete:git:https://github.com'
}
