# Replace AI Translator API 拡張機能パッケージ生成スクリプト
# 使い方:
#   pwsh -NoProfile -File zip.ps1                    # Chrome zip + Firefox xpi 両方
#   pwsh -NoProfile -File zip.ps1 -Target chrome     # Chrome のみ
#   pwsh -NoProfile -File zip.ps1 -Target firefox    # Firefox のみ
#
# ソース manifest.json は Chrome 純正（background.service_worker のみ）。Chrome 版はそのまま .zip 出力。
# Firefox は service_worker 非対応のため build-firefox-manifest.mjs で background.scripts 形式へ変換して .xpi 出力する。

param(
    [ValidateSet("chrome","firefox","both")]
    [string]$Target = "both"
)


# 検証済みの作業対象だけを標準APIで削除する。
function Remove-LocalWorkItem {
    param([string[]]$LiteralPath, [string]$AllowedRoot, [switch]$IgnoreMissing, [switch]$AllowLeafJunction)
    if ([string]::IsNullOrWhiteSpace($AllowedRoot) -or -not [IO.Path]::IsPathRooted($AllowedRoot)) { throw 'Cleanup root must be absolute.' }
    $boundary = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    foreach ($target in $LiteralPath) {
        if ([string]::IsNullOrWhiteSpace($target) -or -not [IO.Path]::IsPathRooted($target)) { throw 'Cleanup target must be absolute.' }
        $resolved = [IO.Path]::GetFullPath($target)
        if (-not $resolved.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup target is outside the allowed root.' }
        $ancestor = $resolved
        while ($ancestor) {
            if (Test-Path -LiteralPath $ancestor) {
                $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not ($AllowLeafJunction -and $ancestor -eq $resolved -and $item.LinkType -eq 'Junction')) { throw 'Cleanup path contains a reparse point.' }
            }
            $ancestor = Split-Path $ancestor -Parent
        }
        if (-not (Test-Path -LiteralPath $resolved)) { if ($IgnoreMissing) { continue }; throw "Cleanup target is missing: $resolved" }
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        $leafLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        if ($item.PSIsContainer -and -not $leafLink) {
            if (@(Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Cleanup directory contains a reparse point.' }
        }
        Remove-Item -LiteralPath $resolved -Recurse:($item.PSIsContainer -and -not $leafLink) -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $resolved) { throw "Cleanup target remains: $resolved" }
    }
}

$ErrorActionPreference = "Stop"

Write-Host "拡張機能パッケージを生成中... (Target: $Target)" -ForegroundColor Cyan
Write-Host ""

# Windows PowerShell 5.1 でも動くよう ?? (PS7+) は使わず明示的にフォールバックする
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PWD.Path }
if ($scriptDir) { Set-Location $scriptDir }

# Chrome/Firefox 両 variant と CI の同梱ディレクトリは package-dirs.txt を正本にする。
# manifest.json は variant 別(Chrome=純正 / Firefox=生成)なので含めず Build-Package 内で個別に扱う。
$PkgDirs = (Get-Content -LiteralPath (Join-Path $scriptDir "package-dirs.txt") -Raw).Trim() -split '\s+'

function Build-Package {
    param(
        [string]$Variant,        # "chrome" | "firefox"
        [string]$OutputName      # "replace-translator-chrome.zip" | "replace-translator-firefox.xpi"
    )

    Write-Host ""
    Write-Host "==== $Variant 版をビルド中 ====" -ForegroundColor Cyan

    if (Test-Path $OutputName) {  Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputName)) -AllowedRoot $PSScriptRoot }

    $tempDir = "temp-build-$Variant"
    if (Test-Path $tempDir) {  Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($tempDir)) -AllowedRoot $PSScriptRoot }
    New-Item -ItemType Directory -Path $tempDir | Out-Null

    Write-Host "ファイルをコピー中..." -ForegroundColor Yellow
    if ($Variant -eq "firefox") {
        # Firefox は background.service_worker 非対応 → scripts 形式へ変換 (importScripts を単一ソースに生成)
        node build-firefox-manifest.mjs "$tempDir/manifest.json"
        if ($LASTEXITCODE -ne 0) { Write-Host "Firefox manifest 生成に失敗しました" -ForegroundColor Red; exit 1 }
    } else {
        Copy-Item "manifest.json" -Destination "$tempDir/manifest.json"  # Chrome はソース manifest をそのまま
    }
    # ローカルの各 OS と CI で package-dirs.txt の同じ列挙を使う。
    foreach ($d in $PkgDirs) { Copy-Item $d -Destination $tempDir -Recurse }

    Get-ChildItem -Path $tempDir -Recurse -Include "*.DS_Store","*.swp","*~" | ForEach-Object {  Remove-LocalWorkItem -LiteralPath $_.FullName -AllowedRoot $PSScriptRoot -IgnoreMissing }

    Write-Host "アーカイブを作成中..." -ForegroundColor Cyan
    $tempZip = "$OutputName.tmp.zip"
    if (Test-Path $tempZip) {  Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($tempZip)) -AllowedRoot $PSScriptRoot }
    Compress-Archive -Path "$tempDir/*" -DestinationPath $tempZip -Force
    Move-Item -Path $tempZip -Destination $OutputName -Force

     Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($tempDir)) -AllowedRoot $PSScriptRoot

    if (Test-Path $OutputName) {
        $sizeKB = [math]::Round((Get-Item $OutputName).Length / 1KB, 2)
        Write-Host "$Variant 版 作成成功: $OutputName ($sizeKB KB)" -ForegroundColor Green
    } else {
        Write-Host "$Variant 版 作成に失敗しました" -ForegroundColor Red
        exit 1
    }
}

if ($Target -eq "chrome" -or $Target -eq "both") {
    Build-Package -Variant "chrome" -OutputName "replace-translator-chrome.zip"
}
if ($Target -eq "firefox" -or $Target -eq "both") {
    Build-Package -Variant "firefox" -OutputName "replace-translator-firefox.xpi"
}

Write-Host ""
Write-Host "✨ パッケージング完了" -ForegroundColor Green
Write-Host "   Chrome Web Store: https://chrome.google.com/webstore/devconsole" -ForegroundColor Blue
Write-Host "   Firefox AMO:      https://addons.mozilla.org/developers/" -ForegroundColor Blue
