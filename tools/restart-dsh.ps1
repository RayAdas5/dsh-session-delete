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
# 找 DSH 可执行文件：先在运行的进程里取（最准），再查常见安装位置。
# 不要写死路径 —— 换台电脑装的位置大概率不一样。
function Resolve-DshExe {
    $proc = Get-Process -Name 'DSH NEXT','DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.Path -and (Test-Path $proc.Path)) { return $proc.Path }
    $candidates = @(
        'C:\DSH\DSH NEXT\DSH NEXT.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\DSH NEXT\DSH NEXT.exe'),
        (Join-Path $env:ProgramFiles 'DSH NEXT\DSH NEXT.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'DSH NEXT\DSH NEXT.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

$exe = Resolve-DshExe
if ($null -eq $exe) {
    Write-Host '找不到 DSH 可执行文件，请手动指定路径或直接手动重启。' -ForegroundColor Red
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
