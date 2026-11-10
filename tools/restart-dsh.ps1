# 重启 DSH NEXT（让新装的 Host 插件生效）
#
# 为什么需要它：Host 半侧插件只在 DSH 启动时装载，刷新页面不会加载
# `dsh-session-delete/lib/index.js` 里的 HTTP 路由。
#
# 用法：在【DSH 之外】的终端里运行
#   powershell -ExecutionPolicy Bypass -File "C:\Users\19393\Documents\deepseek-harness\default-workspace\dsh-session-delete\tools\restart-dsh.ps1"
#
# 也可以在文件资源管理器里右键 → 使用 PowerShell 运行。

$ErrorActionPreference = 'Stop'
$exe = 'C:\DSH\DSH NEXT\DSH NEXT.exe'

if (-not (Test-Path $exe)) {
    Write-Host "找不到 DSH：$exe" -ForegroundColor Red
    exit 1
}

$running = Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host ("正在退出 DSH（{0} 个进程）…" -f $running.Count) -ForegroundColor Yellow
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
} else {
    Write-Host 'DSH 当前没有运行。'
}

Write-Host '正在启动 DSH…'
Start-Process -FilePath $exe
Start-Sleep -Seconds 20

$after = Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue
if ($after) {
    Write-Host ("DSH 已启动（{0} 个进程）。" -f $after.Count) -ForegroundColor Green
    Write-Host '插件加载失败时，日志里会有 [session-delete] 或 cordis 报错。'
} else {
    Write-Host 'DSH 没有起来，检查日志：' -ForegroundColor Red
    Write-Host '  %APPDATA%\..\Local\... 或 C:\Users\19393\.dsh\logs\desktop-next.log'
    Write-Host ''
    Write-Host '如果启动卡住，用备份回滚：' -ForegroundColor Yellow
    Write-Host '  Copy-Item "C:\Users\19393\.dsh\profiles\desktop\package.json.bak-dsh-session-delete" "C:\Users\19393\.dsh\profiles\desktop\package.json" -Force'
    Write-Host '  Remove-Item "C:\Users\19393\.dsh\profiles\desktop\node_modules\dsh-session-delete" -Force'
    exit 1
}
