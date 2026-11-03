#requires -Version 7.2
# 正本: Tools/PowerShell/R2Artifact.Common.ps1。Distribution と同じ scripts に配置する。
. "$PSScriptRoot/R2Distribution.Common.ps1"

function Get-R2ArtifactIdentity {
    param([string]$AccountId, [string]$Bucket, [string]$Name, [string]$Repository, [string]$Commit, [string]$RunId, [string]$RunAttempt)
    if ($AccountId -cnotmatch '^[a-f0-9]{32}$' -or $Bucket -cnotmatch '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' -or
        $Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $Repository -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
        $Commit -cnotmatch '^[a-fA-F0-9]{40}$' -or $RunId -cnotmatch '^[1-9][0-9]*$' -or $RunAttempt -cnotmatch '^[1-9][0-9]*$') {
        Stop-R2Distribution 'artifact' 'invalid-identity'
    }
    $repositoryParts = $Repository.Split('/')
    if (@($repositoryParts | Where-Object { $_ -in @('.', '..') }).Count -gt 0) { Stop-R2Distribution 'artifact' 'invalid-identity' }
    return [ordered]@{ repository = $Repository.ToLowerInvariant(); commit = $Commit.ToLowerInvariant(); runId = $RunId; runAttempt = $RunAttempt; name = $Name }
}

function Get-R2ArtifactPrefix($Identity) {
    # 依存関係の照合証跡は、短期の成果物とは別の保持規則にする。
    $root = if ($Identity.name.StartsWith('deps.', [StringComparison]::Ordinal)) { 'ci-evidence' } else { 'ci-artifacts' }
    return "$root/$($Identity.repository)/$($Identity.runId)/$($Identity.runAttempt)/$($Identity.commit)/$($Identity.name)"
}

function Assert-R2ArtifactRelativePath([string]$Path) {
    # Windows/macOS/Linux 間で復元可能な通常ファイルに限定する。
    if (!$Path -or $Path.StartsWith('/') -or $Path -match '[\x00-\x1f\x7f\\:<>"|?*]') { Stop-R2Distribution 'artifact' 'invalid-path' }
    foreach ($part in $Path.Split('/')) {
        if (!$part -or $part -in @('.', '..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Stop-R2Distribution 'artifact' 'invalid-path' }
    }
}

function Assert-R2ArtifactNoLinks([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { Stop-R2Distribution 'artifact' 'link-rejected' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }; $current = $parent
    }
}

function Get-R2ArtifactFiles([string[]]$Paths) {
    $files = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $roots = [Collections.Generic.List[string]]::new()
    foreach ($inputPath in $Paths) {
        if (!$inputPath -or $inputPath.StartsWith('!') -or $inputPath -match '[\[\]]') { Stop-R2Distribution 'artifact' 'unsupported-pattern' }
        $full = [IO.Path]::GetFullPath($inputPath)
        $wildcard = $full.IndexOfAny([char[]]'*?')
        if ($wildcard -ge 0) {
            $before = $full.Substring(0, $wildcard)
            $root = [IO.Path]::GetDirectoryName($before.TrimEnd([IO.Path]::DirectorySeparatorChar))
            if ($before.EndsWith([string][IO.Path]::DirectorySeparatorChar)) { $root = $before.TrimEnd([IO.Path]::DirectorySeparatorChar) }
            if (!$root) { Stop-R2Distribution 'artifact' 'invalid-path' }
            Assert-R2ArtifactNoLinks $root
            $normalized = $full.Replace('\', '/')
            $regex = [regex]::Escape($normalized).Replace('\*\*/', '(?:.*/)?').Replace('\*\*', '.*').Replace('\*', '[^/]*').Replace('\?', '[^/]')
            $entries = @(Get-ChildItem -LiteralPath $root -File -Force -Recurse -ErrorAction Stop | Where-Object { $_.FullName.Replace('\','/') -cmatch "^$regex$" })
        } else {
            Assert-R2ArtifactNoLinks $full
            $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
            if ($item.PSIsContainer) { $root = $item.FullName; $entries = @(Get-ChildItem -LiteralPath $root -File -Force -Recurse -ErrorAction Stop) }
            else { $root = $item.DirectoryName; $entries = @($item) }
        }
        if ($entries.Count -eq 0) { Stop-R2Distribution 'artifact' 'empty-input' }
        $roots.Add([IO.Path]::GetFullPath($root))
        foreach ($entry in $entries) {
            Assert-R2ArtifactNoLinks $entry.FullName
            $files[$entry.FullName] = $entry
        }
    }
    if ($files.Count -eq 0) { Stop-R2Distribution 'artifact' 'empty-input' }
    $common = $roots[0]
    foreach ($root in $roots) {
        while ($root -ne $common -and !$root.StartsWith($common.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            $common = [IO.Path]::GetDirectoryName($common)
            if (!$common) { Stop-R2Distribution 'artifact' 'unrelated-roots' }
        }
    }
    $relativePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [string[]]$orderedFiles = @($files.Keys)
    [Array]::Sort($orderedFiles, [StringComparer]::Ordinal)
    foreach ($fileName in $orderedFiles) {
        $entry = $files[$fileName]
        $relative = [IO.Path]::GetRelativePath($common, $entry.FullName).Replace('\','/')
        Assert-R2ArtifactRelativePath $relative
        if (!$relativePaths.Add($relative)) { Stop-R2Distribution 'artifact' 'duplicate-path' }
        [pscustomobject]@{ FullName = $entry.FullName; RelativePath = $relative }
    }
}

function Get-R2ArtifactObjectAddress([string]$AccountId, [string]$Bucket, [string]$Key) {
    $path = '/' + $Bucket + '/' + (($Key.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/')
    return @{ Uri = [uri]("https://$AccountId.r2.cloudflarestorage.com" + $path); Path = $path }
}

function Get-R2ArtifactObject {
    param([Net.Http.HttpClient]$Client, [hashtable]$Credentials, [string]$AccountId, [string]$Bucket, [string]$Key,
        [IO.Stream]$Output, [long]$MaximumSize, [long]$ExpectedSize = -1, [string]$ExpectedHash)
    $address = Get-R2ArtifactObjectAddress $AccountId $Bucket $Key
    $request = New-R2DistributionRequest 'GET' $address.Uri $address.Path 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' $Credentials
    $response = $null; $body = $null; $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    $deadline = [Threading.CancellationTokenSource]::new($Client.Timeout)
    try {
        $response = Send-R2DistributionRequest $Client $request 'artifact-get' $deadline.Token
        if ([int]$response.StatusCode -ne 200) { Stop-R2Distribution 'artifact-get' 'http-rejected' ([int]$response.StatusCode) }
        $length = $response.Content.Headers.ContentLength
        if ($null -ne $length -and ($length -gt $MaximumSize -or ($ExpectedSize -ge 0 -and $length -ne $ExpectedSize))) { Stop-R2Distribution 'artifact-get' 'size-mismatch' }
        $body = $response.Content.ReadAsStreamAsync($deadline.Token).GetAwaiter().GetResult()
        $buffer = [byte[]]::new(65536); [long]$size = 0
        while (($count = $body.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
            $size += $count
            if ($size -gt $MaximumSize) { Stop-R2Distribution 'artifact-get' 'size-mismatch' }
            $hash.AppendData($buffer, 0, $count); $Output.Write($buffer, 0, $count)
        }
        $actualHash = [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()
        if (($ExpectedSize -ge 0 -and $size -ne $ExpectedSize) -or ($ExpectedHash -and $actualHash -cne $ExpectedHash)) { Stop-R2Distribution 'artifact-get' 'body-mismatch' }
    } catch {
        if ($deadline.IsCancellationRequested) { Stop-R2Distribution 'artifact-get' 'timeout' }
        throw
    } finally { if ($null -ne $body) { $body.Dispose() }; if ($null -ne $response) { $response.Dispose() }; $request.Dispose(); $hash.Dispose(); $deadline.Dispose() }
}

function Publish-R2ArtifactManifest {
    param([Net.Http.HttpClient]$Client, [hashtable]$Credentials, [string]$AccountId, [string]$Bucket, [string]$Key, [byte[]]$Bytes)
    $address = Get-R2ArtifactObjectAddress $AccountId $Bucket $Key
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
    $request = New-R2DistributionRequest 'PUT' $address.Uri $address.Path $hash $Credentials @{ 'if-none-match' = '*'; 'cache-control' = 'no-store' }
    $response = $null
    try {
        $request.Content = [Net.Http.ByteArrayContent]::new($Bytes)
        $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('application/json')
        $response = Send-R2DistributionRequest $Client $request 'artifact-manifest'
        $status = [int]$response.StatusCode
        if ($status -ne 200 -and $status -ne 412) {
            if ($status -ge 400 -and $status -lt 500) { Stop-R2Distribution 'artifact-manifest' 'http-rejected' $status }
            Stop-R2Distribution 'artifact-manifest' 'unknown-no-resend' $status
        }
        $null = Assert-R2DistributionRemote $Client $address.Uri $address.Path $Credentials $Bytes.LongLength $hash
    } finally { if ($null -ne $response) { $response.Dispose() }; $request.Dispose() }
}

function Invoke-R2ArtifactSafeFailure([Exception]$Failure) {
    while ($null -ne $Failure) {
        if ($Failure.Data['R2DistributionSafe'] -eq $true -and $Failure.Message -cmatch '^R2 transfer stopped: phase=([a-z-]+) code=([a-z-]+)(?: httpStatus=([1-5][0-9]{2}))?$') {
            Stop-R2Distribution $Matches[1] $Matches[2] $(if ($Matches[3]) { [int]$Matches[3] } else { 0 })
        }
        $Failure = $Failure.InnerException
    }
    Stop-R2Distribution 'artifact' 'operation-failed'
}

function Publish-R2Artifact {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AccountId, [Parameter(Mandatory)][string]$Bucket,
        [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string[]]$Path,
        [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN, [string]$AccessKeyId = $env:AWS_ACCESS_KEY_ID, [string]$SecretAccessKey = $env:AWS_SECRET_ACCESS_KEY,
        [string]$Repository = $env:GITHUB_REPOSITORY, [string]$Commit = $env:GITHUB_SHA,
        [string]$RunId = $env:GITHUB_RUN_ID, [string]$RunAttempt = $env:GITHUB_RUN_ATTEMPT)
    $client = $null
    if ($ApiToken -and !$PSBoundParameters.ContainsKey('AccessKeyId') -and !$PSBoundParameters.ContainsKey('SecretAccessKey')) { $AccessKeyId = ''; $SecretAccessKey = '' }
    try {
        if ($PSBoundParameters.ContainsKey('AccessKeyId') -xor $PSBoundParameters.ContainsKey('SecretAccessKey')) { Stop-R2Distribution 'credentials' 'invalid-input' }
        $identity = Get-R2ArtifactIdentity $AccountId $Bucket $Name $Repository $Commit $RunId $RunAttempt
        $prefix = Get-R2ArtifactPrefix $identity
        $inputs = @(Get-R2ArtifactFiles $Path)
        $client = New-R2DistributionClient
        $credentials = Get-R2DistributionCredentials $client $AccountId $ApiToken $AccessKeyId $SecretAccessKey
        $entries = @(
            foreach ($inputFile in $inputs) {
                $key = "$prefix/files/$($inputFile.RelativePath)"
                $result = Publish-R2Object -AccountId $AccountId -Bucket $Bucket -Key $key -FilePath $inputFile.FullName -AccessKeyId $credentials.AccessKeyId -SecretAccessKey $credentials.SecretAccessKey -Immutable -CacheControl 'no-store'
                [ordered]@{ path = $inputFile.RelativePath; key = $key; size = $result.Size; sha256 = $result.SHA256 }
            }
        )
        $manifest = [ordered]@{ schema = 1; identity = $identity; files = $entries }
        $bytes = [Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 8 -Compress))
        if ($bytes.Length -gt 16777216) { Stop-R2Distribution 'artifact' 'manifest-too-large' }
        Publish-R2ArtifactManifest $client $credentials $AccountId $Bucket "$prefix/manifest.json" $bytes
        return [pscustomobject]@{ Name = $Name; Count = $entries.Count; ManifestKey = "$prefix/manifest.json" }
    } catch { Invoke-R2ArtifactSafeFailure $_.Exception }
    finally { if ($null -ne $client) { $client.Dispose() }; $credentials = $null; $ApiToken = $null; $SecretAccessKey = $null }
}

function Receive-R2Artifact {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AccountId, [Parameter(Mandatory)][string]$Bucket,
        [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Destination,
        [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN, [string]$AccessKeyId = $env:AWS_ACCESS_KEY_ID, [string]$SecretAccessKey = $env:AWS_SECRET_ACCESS_KEY,
        [string]$Repository = $env:GITHUB_REPOSITORY, [string]$Commit = $env:GITHUB_SHA,
        [string]$RunId = $env:GITHUB_RUN_ID, [string]$RunAttempt = $env:GITHUB_RUN_ATTEMPT)
    $client = $null; $memory = $null
    if ($ApiToken -and !$PSBoundParameters.ContainsKey('AccessKeyId') -and !$PSBoundParameters.ContainsKey('SecretAccessKey')) { $AccessKeyId = ''; $SecretAccessKey = '' }
    try {
        if ($PSBoundParameters.ContainsKey('AccessKeyId') -xor $PSBoundParameters.ContainsKey('SecretAccessKey')) { Stop-R2Distribution 'credentials' 'invalid-input' }
        $identity = Get-R2ArtifactIdentity $AccountId $Bucket $Name $Repository $Commit $RunId $RunAttempt
        $prefix = Get-R2ArtifactPrefix $identity
        $target = [IO.Path]::GetFullPath($Destination)
        Assert-R2ArtifactNoLinks $target
        if (Test-Path -LiteralPath $target) { Stop-R2Distribution 'artifact' 'destination-exists' }
        $client = New-R2DistributionClient
        $credentials = Get-R2DistributionCredentials $client $AccountId $ApiToken $AccessKeyId $SecretAccessKey
        $memory = [IO.MemoryStream]::new()
        Get-R2ArtifactObject $client $credentials $AccountId $Bucket "$prefix/manifest.json" $memory 16777216
        $manifest = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray()) | ConvertFrom-Json -AsHashtable
        if ($manifest.schema -ne 1 -or !$manifest.identity -or !$manifest.files -or $manifest.files -isnot [array]) { Stop-R2Distribution 'artifact' 'invalid-manifest' }
        foreach ($nameProperty in $identity.Keys) {
            if ($manifest.identity[$nameProperty] -cne $identity[$nameProperty]) { Stop-R2Distribution 'artifact' 'identity-mismatch' }
        }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $manifest.files) {
            if ($entry.path -isnot [string] -or $entry.key -isnot [string] -or
                ($entry.size -isnot [long] -and $entry.size -isnot [int]) -or $entry.size -lt 0 -or
                $entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch '^[a-f0-9]{64}$') { Stop-R2Distribution 'artifact' 'invalid-manifest' }
            Assert-R2ArtifactRelativePath $entry.path
            if (!$seen.Add($entry.path) -or $entry.key -cne "$prefix/files/$($entry.path)") { Stop-R2Distribution 'artifact' 'invalid-manifest' }
        }
        # 全 path を検査してから新規 destination を作る。既存 checkout には上書きしない。
        [void][IO.Directory]::CreateDirectory($target)
        foreach ($entry in $manifest.files) {
            $outputPath = [IO.Path]::GetFullPath([IO.Path]::Combine($target, $entry.path))
            if (!$outputPath.StartsWith($target.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Stop-R2Distribution 'artifact' 'invalid-path' }
            Assert-R2ArtifactNoLinks $outputPath
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputPath))
            $outputFile = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { Get-R2ArtifactObject $client $credentials $AccountId $Bucket $entry.key $outputFile $entry.size $entry.size $entry.sha256 }
            finally { $outputFile.Dispose() }
        }
        return [pscustomobject]@{ Name = $Name; Count = $manifest.files.Count; Destination = $target }
    } catch { Invoke-R2ArtifactSafeFailure $_.Exception }
    finally { if ($null -ne $memory) { $memory.Dispose() }; if ($null -ne $client) { $client.Dispose() }; $credentials = $null; $ApiToken = $null; $SecretAccessKey = $null }
}
