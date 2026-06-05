# リプレース翻訳 拡張機能パッケージ生成スクリプト
# 使い方:
#   powershell -ExecutionPolicy Bypass -File zip.ps1                    # Chrome + Firefox 両方
#   powershell -ExecutionPolicy Bypass -File zip.ps1 -Target chrome     # Chrome のみ
#   powershell -ExecutionPolicy Bypass -File zip.ps1 -Target firefox    # Firefox のみ
#
# Firefox 版は manifest.firefox.json を manifest.json として同梱し、xpi 拡張子で出力する。

param(
    [ValidateSet("chrome","firefox","both")]
    [string]$Target = "both"
)

$ErrorActionPreference = "Stop"

Write-Host "拡張機能パッケージを生成中... (Target: $Target)" -ForegroundColor Cyan
Write-Host ""

# Windows PowerShell 5.1 でも動くよう ?? (PS7+) は使わず明示的にフォールバックする
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PWD.Path }
if ($scriptDir) { Set-Location $scriptDir }

Write-Host "依存パッケージを lockfile どおりにインストール中..." -ForegroundColor Yellow
pnpm install --frozen-lockfile --silent
if ($LASTEXITCODE -ne 0) {
    Write-Host "pnpm install に失敗しました (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

Write-Host "アイコンを生成中..." -ForegroundColor Yellow
node scripts/generate-icons.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "アイコン生成に失敗しました (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

function Build-Package {
    param(
        [string]$Variant,        # "chrome" | "firefox"
        [string]$ManifestSource, # "manifest.json" | "manifest.firefox.json"
        [string]$OutputName      # "replace-translator-chrome.zip" | "replace-translator-firefox.xpi"
    )

    Write-Host ""
    Write-Host "==== $Variant 版をビルド中 ====" -ForegroundColor Cyan

    if (Test-Path $OutputName) { Remove-Item $OutputName -Force }

    $tempDir = "temp-build-$Variant"
    if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir | Out-Null

    Write-Host "ファイルをコピー中 ($ManifestSource -> manifest.json)..." -ForegroundColor Yellow
    Copy-Item $ManifestSource -Destination "$tempDir/manifest.json"
    Copy-Item "icons" -Destination $tempDir -Recurse
    Copy-Item "src" -Destination $tempDir -Recurse
    Copy-Item "_locales" -Destination $tempDir -Recurse

    Get-ChildItem -Path $tempDir -Recurse -Include "*.DS_Store","*.swp","*~" | Remove-Item -Force

    Write-Host "アーカイブを作成中..." -ForegroundColor Cyan
    $tempZip = "$OutputName.tmp.zip"
    if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
    Compress-Archive -Path "$tempDir/*" -DestinationPath $tempZip -Force
    Move-Item -Path $tempZip -Destination $OutputName -Force

    Remove-Item $tempDir -Recurse -Force

    if (Test-Path $OutputName) {
        $sizeKB = [math]::Round((Get-Item $OutputName).Length / 1KB, 2)
        Write-Host "$Variant 版 作成成功: $OutputName ($sizeKB KB)" -ForegroundColor Green
    } else {
        Write-Host "$Variant 版 作成に失敗しました" -ForegroundColor Red
        exit 1
    }
}

if ($Target -eq "chrome" -or $Target -eq "both") {
    Build-Package -Variant "chrome" -ManifestSource "manifest.json" -OutputName "replace-translator-chrome.zip"
}
if ($Target -eq "firefox" -or $Target -eq "both") {
    Build-Package -Variant "firefox" -ManifestSource "manifest.firefox.json" -OutputName "replace-translator-firefox.xpi"
}

Write-Host ""
Write-Host "✨ パッケージング完了" -ForegroundColor Green
Write-Host "   Chrome Web Store: https://chrome.google.com/webstore/devconsole" -ForegroundColor Blue
Write-Host "   Firefox AMO:      https://addons.mozilla.org/developers/" -ForegroundColor Blue
