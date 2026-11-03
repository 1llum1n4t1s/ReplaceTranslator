#requires -Version 7.0
[CmdletBinding()]
param([string]$OutputPath = 'amo-metadata.json')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$metadata = @{
    categories = @('other')
    homepage = @{ 'en-US' = 'https://github.com/1llum1n4t1s/ReplaceTranslator' }
    support_url = @{ 'en-US' = 'https://github.com/1llum1n4t1s/ReplaceTranslator/issues' }
    version = @{ license = $(if ($package.license) { $package.license } else { 'MIT' }) }
    name = @{}; summary = @{}; description = @{}
}
foreach ($language in @(@('ja','ja'), @('en-US','en'))) {
    $sections = [Collections.Generic.List[Collections.Generic.List[string]]]::new()
    foreach ($line in ((Get-Content -LiteralPath (Join-Path $root "webstore/store-listing.firefox.$($language[1]).txt") -Raw) -split '\r?\n')) {
        if ($line.StartsWith('■')) { $sections.Add([Collections.Generic.List[string]]::new()) }
        elseif ($sections.Count) { $sections[$sections.Count - 1].Add($line) }
    }
    if ($sections.Count -lt 3) { throw 'Listing requires name, summary and description sections' }
    $metadata.name[$language[0]] = ($sections[0] -join "`n").Trim()
    $metadata.summary[$language[0]] = ($sections[1] -join "`n").Trim()
    $description = for ($i=2; $i -lt $sections.Count; $i++) {
        $body = ($sections[$i] -join "`n").Trim()
        if ($body) { $body }
    }
    $metadata.description[$language[0]] = ($description -join "`n`n").Trim()
}
$metadata | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output 'AMO metadata generated'
