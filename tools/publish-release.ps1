# Publish (or update) a GitHub release for this repo.
#
# Why a script: PowerShell 5.1 encodes string request bodies as ISO-8859-1, which
# turns every Chinese character into "?". This script reads the notes from a
# UTF-8 file and sends the JSON as UTF-8 bytes, so the release body stays intact.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\publish-release.ps1 `
#       -Tag v1.0.1 -NotesFile dist\release-notes.md -Asset dist\dsh-session-delete-1.0.1.tgz
#
# If the release does not exist it is created; if it does, its title and body are
# updated in place (assets are only uploaded when missing).

param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$NotesFile,
    [string]$Asset = '',
    [string]$Repo = 'RayAdas5/dsh-session-delete',
    [string]$Proxy = ''
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = Join-Path $PSScriptRoot '..'
$notesPath = Join-Path $repoRoot $NotesFile
if (-not (Test-Path $notesPath)) {
    Write-Host "Notes file not found: $notesPath" -ForegroundColor Red
    exit 1
}
# -Encoding UTF8 is what keeps the Chinese readable on Windows PowerShell 5.1.
# The [string] cast matters: Get-Content -Raw hands back a string with ETS
# wrapper properties, and ConvertTo-Json happily recurses into those, producing a
# 97 MB document that GitHub rejects as "body is too long". Casting strips it.
$notes = [string](Get-Content $notesPath -Raw -Encoding UTF8)

# --- token from Git Credential Manager (never printed) ---
$credInput = "protocol=https`nhost=github.com`n`n"
$credRaw = ($credInput | git credential fill) | Out-String
$token = ($credRaw -split "`n" | Where-Object { $_ -match '^password=' } | Select-Object -First 1) -replace '^password=', ''
$token = $token.Trim()
if ($token.Length -lt 20) {
    Write-Host 'Could not read a GitHub token from the credential manager.' -ForegroundColor Red
    exit 1
}

$headers = @{ Authorization = "token $token"; 'User-Agent' = 'dsh-session-delete-release' }
$common = @{}
if ($Proxy -ne '') { $common['Proxy'] = $Proxy }

function Invoke-GitHubJson {
    param([string]$Uri, [string]$Method, $Payload)
    $json = $Payload | ConvertTo-Json -Depth 6
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Uri $Uri -Method $Method -Headers $headers `
        -Body $bytes -ContentType 'application/json; charset=utf-8' `
        -TimeoutSec 60 @common
}

Write-Host "Looking up release $Tag ..."
$existing = $null
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" `
        -Headers $headers -TimeoutSec 30 @common -ErrorAction Stop
} catch {
    $existing = $null
}

if ($null -ne $existing) {
    Write-Host "Updating existing release (id $($existing.id)) ..." -ForegroundColor Cyan
    $release = Invoke-GitHubJson -Uri "https://api.github.com/repos/$Repo/releases/$($existing.id)" `
        -Method Patch -Payload @{ name = $Tag; body = $notes }
} else {
    Write-Host "Creating release $Tag ..." -ForegroundColor Cyan
    $release = Invoke-GitHubJson -Uri "https://api.github.com/repos/$Repo/releases" `
        -Method Post -Payload @{
            tag_name = $Tag
            target_commitish = 'main'
            name = $Tag
            body = $notes
            draft = $false
            prerelease = $false
        }
}
Write-Host "Release: $($release.html_url)"

if ($Asset -ne '') {
    $assetPath = Join-Path $repoRoot $Asset
    if (-not (Test-Path $assetPath)) {
        Write-Host "Asset not found: $assetPath" -ForegroundColor Red
        exit 1
    }
    $assetName = Split-Path $assetPath -Leaf
    $already = $release.assets | Where-Object { $_.name -eq $assetName }
    if ($null -ne $already) {
        Write-Host "Asset already attached: $assetName ($($already.size) bytes)" -ForegroundColor Yellow
    } else {
        Write-Host "Uploading $assetName ..."
        $bytes = [System.IO.File]::ReadAllBytes($assetPath)
        $uploaded = Invoke-RestMethod `
            -Uri "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=$assetName" `
            -Method Post -Headers $headers -Body $bytes `
            -ContentType 'application/octet-stream' -TimeoutSec 300 @common
        Write-Host "Uploaded: $($uploaded.name) $($uploaded.size) bytes" -ForegroundColor Green
        Write-Host "Download: $($uploaded.browser_download_url)"
    }
}
