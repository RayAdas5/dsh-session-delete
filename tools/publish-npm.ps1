# Publish dist/npm-publish.json to the npm registry.
#
# Why two steps: the npm publish endpoint wants one PUT with the tarball inlined
# as base64. tools/publish-npm.mjs builds that JSON (Node writes UTF-8 correctly),
# this script only sends it through the proxy.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\publish-npm.ps1 -TokenFile C:\path\to\token.txt
#
# The token file holds nothing but the token (npm_...). Keep it out of the repo.

param(
    [Parameter(Mandatory = $true)][string]$TokenFile,
    [string]$Proxy = 'http://127.0.0.1:7897'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = Join-Path $PSScriptRoot '..'
$payloadPath = Join-Path $repoRoot 'dist\npm-publish.json'
if (-not (Test-Path $payloadPath)) {
    Write-Host "Missing $payloadPath - run: node tools/publish-npm.mjs" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $TokenFile)) {
    Write-Host "Token file not found: $TokenFile" -ForegroundColor Red
    exit 1
}
$token = [string](Get-Content $TokenFile -Raw -Encoding UTF8)
$token = $token.Trim()
if ($token.Length -lt 20) {
    Write-Host 'Token looks too short. Save only the npm_... string, no quotes.' -ForegroundColor Red
    exit 1
}

# [string] cast: Get-Content -Raw strings carry ETS properties that ConvertTo-Json
# would happily recurse into.
$pkgRaw = [string](Get-Content (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8)
$pkg = $pkgRaw | ConvertFrom-Json
$name = [string]$pkg.name
$version = [string]$pkg.version

$bytes = [System.IO.File]::ReadAllBytes($payloadPath)
Write-Host "Publishing $name@$version ($($bytes.Length) bytes) ..." -ForegroundColor Cyan

$headers = @{
    Authorization = "Bearer $token"
    'User-Agent'  = 'dsh-session-delete-publish'
}
$uri = 'https://registry.npmjs.org/' + [uri]::EscapeDataString($name)

try {
    $resp = Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -Body $bytes `
        -ContentType 'application/json' -Proxy $Proxy -TimeoutSec 240 -ErrorAction Stop
    Write-Host "Published: $name@$version" -ForegroundColor Green
    Write-Host "https://www.npmjs.com/package/$name"
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    Write-Host "Publish failed (HTTP $status): $($_.Exception.Message)" -ForegroundColor Red
    try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd()
        if ($body) { Write-Host $body }
    } catch {
        # response body unreadable; the message above is all we get
    }
    exit 1
}

Write-Host ''
Write-Host 'Verify with:'
Write-Host "  Invoke-RestMethod https://registry.npmjs.org/$name -Proxy $Proxy | Select-Object name, dist-tags"
