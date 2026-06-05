# Replace AI Translator API 拡張機能パッケージ生成スクリプト
# 使い方:
#   powershell -ExecutionPolicy Bypass -File zip.ps1                    # Chrome zip + Firefox xpi 両方
#   powershell -ExecutionPolicy Bypass -File zip.ps1 -Target chrome     # Chrome のみ
#   powershell -ExecutionPolicy Bypass -File zip.ps1 -Target firefox    # Firefox のみ
#
# Chrome/Firefox は単一 manifest.json を共有する（background に service_worker と scripts を併記）。
# Chrome 版は .zip、Firefox 版は .xpi 拡張子で出力する（中身は同一）。

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

function Build-Package {
    param(
        [string]$Variant,        # "chrome" | "firefox"
        [string]$OutputName      # "replace-translator-chrome.zip" | "replace-translator-firefox.xpi"
    )

    Write-Host ""
    Write-Host "==== $Variant 版をビルド中 ====" -ForegroundColor Cyan

    if (Test-Path $OutputName) { Remove-Item $OutputName -Force }

    $tempDir = "temp-build-$Variant"
    if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir | Out-Null

    Write-Host "ファイルをコピー中..." -ForegroundColor Yellow
    Copy-Item "manifest.json" -Destination "$tempDir/manifest.json"
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
    Build-Package -Variant "chrome" -OutputName "replace-translator-chrome.zip"
}
if ($Target -eq "firefox" -or $Target -eq "both") {
    Build-Package -Variant "firefox" -OutputName "replace-translator-firefox.xpi"
}

Write-Host ""
Write-Host "✨ パッケージング完了" -ForegroundColor Green
Write-Host "   Chrome Web Store: https://chrome.google.com/webstore/devconsole" -ForegroundColor Blue
Write-Host "   Firefox AMO:      https://addons.mozilla.org/developers/" -ForegroundColor Blue
