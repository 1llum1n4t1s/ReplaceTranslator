#requires -Version 7.2
# 正本: Tools/PowerShell/R2Distribution.Common.ps1。各リポジトリへ同一内容を配置する。

function Stop-R2Distribution([string]$Phase, [string]$Code, [int]$Status = 0) {
    $message = "R2 transfer stopped: phase=$Phase code=$Code"
    if ($Status -gt 0) { $message += " httpStatus=$Status" }
    $failure = [InvalidOperationException]::new($message)
    $failure.Data['R2DistributionSafe'] = $true
    throw $failure
}

function Get-R2DistributionHash([IO.Stream]$Stream) {
    $Stream.Position = 0
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($hash.ComputeHash($Stream)).ToLowerInvariant() }
    finally { $hash.Dispose(); $Stream.Position = 0 }
}

function Get-R2DistributionHmac([byte[]]$Key, [string]$Text) {
    $hmac = [Security.Cryptography.HMACSHA256]::new($Key)
    try { return ,$hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) }
    finally { $hmac.Dispose() }
}

function Get-R2DistributionAuthorization {
    param([string]$Method, [string]$CanonicalPath, [Collections.IDictionary]$Headers,
        [string]$PayloadHash, [string]$Timestamp, [string]$AccessKeyId, [string]$SecretAccessKey,
        [string]$Region = 'auto')
    [string[]]$names = @($Headers.Keys | ForEach-Object { $_.ToLowerInvariant() })
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $canonicalHeaders = ($names | ForEach-Object { $_ + ':' + ([regex]::Replace([string]$Headers[$_], '\s+', ' ').Trim()) + "`n" }) -join ''
    $signedHeaders = $names -join ';'
    $canonical = "$Method`n$CanonicalPath`n`n$canonicalHeaders`n$signedHeaders`n$PayloadHash"
    $canonicalHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant()
    $date = $Timestamp.Substring(0, 8)
    $scope = "$date/$Region/s3/aws4_request"
    $dateKey = Get-R2DistributionHmac ([Text.Encoding]::UTF8.GetBytes('AWS4' + $SecretAccessKey)) $date
    $regionKey = Get-R2DistributionHmac $dateKey $Region
    $serviceKey = Get-R2DistributionHmac $regionKey 's3'
    $signingKey = Get-R2DistributionHmac $serviceKey 'aws4_request'
    try { $signature = [Convert]::ToHexString((Get-R2DistributionHmac $signingKey "AWS4-HMAC-SHA256`n$Timestamp`n$scope`n$canonicalHash")).ToLowerInvariant() }
    finally { foreach ($bytes in @($dateKey, $regionKey, $serviceKey, $signingKey)) { [Array]::Clear($bytes) } }
    return "AWS4-HMAC-SHA256 Credential=$AccessKeyId/$scope, SignedHeaders=$signedHeaders, Signature=$signature"
}

function New-R2DistributionClient {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.AutomaticDecompression = [Net.DecompressionMethods]::None
    $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [TimeSpan]::FromMinutes(60)
    return $client
}

function Send-R2DistributionRequest([Net.Http.HttpClient]$Client, [Net.Http.HttpRequestMessage]$Request, [string]$Phase, [Threading.CancellationToken]$CancellationToken = [Threading.CancellationToken]::None) {
    try { return $Client.SendAsync($Request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $CancellationToken).GetAwaiter().GetResult() }
    catch {
        if ($Request.Method.Method -eq 'PUT') { Stop-R2Distribution $Phase 'unknown-no-resend' }
        Stop-R2Distribution $Phase 'transport-failed'
    }
}

function Get-R2DistributionCredentials {
    param([Net.Http.HttpClient]$Client, [string]$AccountId, [string]$ApiToken, [string]$AccessKeyId, [string]$SecretAccessKey)
    if ($AccessKeyId -or $SecretAccessKey) {
        if (!$AccessKeyId -or !$SecretAccessKey -or $AccessKeyId -cnotmatch '^[A-Za-z0-9]+$' -or $SecretAccessKey -match '[\r\n]') { Stop-R2Distribution 'credentials' 'invalid-input' }
        return @{ AccessKeyId = $AccessKeyId; SecretAccessKey = $SecretAccessKey }
    }
    if (!$ApiToken -or $ApiToken -match '[\r\n]') { Stop-R2Distribution 'credentials' 'missing' }
    foreach ($path in @('user/tokens/verify', "accounts/$AccountId/tokens/verify")) {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "https://api.cloudflare.com/client/v4/$path")
        $response = $null
        $deadline = [Threading.CancellationTokenSource]::new($Client.Timeout)
        try {
            $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $ApiToken)
            $response = Send-R2DistributionRequest $Client $request 'credentials' $deadline.Token
            if ([int]$response.StatusCode -ne 200) { continue }
            $body = $response.Content.ReadAsStringAsync($deadline.Token).GetAwaiter().GetResult() | ConvertFrom-Json
            if ($body.success -eq $true -and $body.result.status -eq 'active' -and $body.result.id -cmatch '^[a-fA-F0-9]{32}$') {
                return @{ AccessKeyId = [string]$body.result.id; SecretAccessKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ApiToken))).ToLowerInvariant() }
            }
        } catch {
            if ($deadline.IsCancellationRequested) { Stop-R2Distribution 'credentials' 'timeout' }
            throw
        } finally { if ($null -ne $response) { $response.Dispose() }; $request.Dispose(); $deadline.Dispose() }
    }
    Stop-R2Distribution 'credentials' 'verification-failed'
}

function New-R2DistributionRequest {
    param([string]$Method, [uri]$Uri, [string]$CanonicalPath, [string]$PayloadHash,
        [hashtable]$Credentials, [hashtable]$ExtraHeaders = @{})
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ', [Globalization.CultureInfo]::InvariantCulture)
    $headers = @{ host = $Uri.Authority; 'x-amz-date' = $timestamp; 'x-amz-content-sha256' = $PayloadHash }
    foreach ($name in $ExtraHeaders.Keys) { $headers[$name] = $ExtraHeaders[$name] }
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), $Uri)
    foreach ($name in $headers.Keys) { [void]$request.Headers.TryAddWithoutValidation($name, [string]$headers[$name]) }
    $authorization = Get-R2DistributionAuthorization $Method $CanonicalPath $headers $PayloadHash $timestamp $Credentials.AccessKeyId $Credentials.SecretAccessKey
    [void]$request.Headers.TryAddWithoutValidation('Authorization', $authorization)
    return $request
}

function Assert-R2DistributionRemote {
    param([Net.Http.HttpClient]$Client, [uri]$Uri, [string]$CanonicalPath, [hashtable]$Credentials, [long]$Size, [string]$Hash, [string]$ExpectedETag)
    $request = New-R2DistributionRequest 'GET' $Uri $CanonicalPath 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' $Credentials
    $response = $null; $stream = $null
    $deadline = [Threading.CancellationTokenSource]::new($Client.Timeout)
    $hashState = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $response = Send-R2DistributionRequest $Client $request 'verify' $deadline.Token
        if ([int]$response.StatusCode -ne 200) { Stop-R2Distribution 'verify' 'http-rejected' ([int]$response.StatusCode) }
        if ($ExpectedETag -and [string]$response.Headers.ETag -cne $ExpectedETag) { Stop-R2Distribution 'verify' 'concurrent-change' }
        if ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $Size) { Stop-R2Distribution 'verify' 'body-mismatch' }
        $stream = $response.Content.ReadAsStreamAsync($deadline.Token).GetAwaiter().GetResult()
        $buffer = [byte[]]::new(65536); [long]$sizeRead = 0
        while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
            $sizeRead += $count
            if ($sizeRead -gt $Size) { Stop-R2Distribution 'verify' 'body-mismatch' }
            $hashState.AppendData($buffer, 0, $count)
        }
        if ($sizeRead -ne $Size) { Stop-R2Distribution 'verify' 'body-mismatch' }
        $actual = [Convert]::ToHexString($hashState.GetHashAndReset()).ToLowerInvariant()
        if ($actual -cne $Hash) { Stop-R2Distribution 'verify' 'body-mismatch' }
        return [string]$response.Headers.ETag
    } catch {
        if ($deadline.IsCancellationRequested) { Stop-R2Distribution 'verify' 'timeout' }
        throw
    } finally { if ($null -ne $stream) { $stream.Dispose() }; if ($null -ne $response) { $response.Dispose() }; $request.Dispose(); $hashState.Dispose(); $deadline.Dispose() }
}

function Publish-R2Object {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AccountId,
        [Parameter(Mandatory)][string]$Bucket,
        [Parameter(Mandatory)][string]$FilePath,
        [string]$Key,
        [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN,
        [string]$AccessKeyId = $env:AWS_ACCESS_KEY_ID,
        [string]$SecretAccessKey = $env:AWS_SECRET_ACCESS_KEY,
        [string]$CacheControl,
        [string]$ContentType = 'application/octet-stream',
        [switch]$Immutable,
        [string]$ExpectedETag
    )
    $client = $null; $file = $null; $request = $null; $put = $null; $response = $null; $phase = 'input'
    # 明示した認証方式を、別サービス用の AWS 環境変数で上書きしない。
    if ($ApiToken -and !$PSBoundParameters.ContainsKey('AccessKeyId') -and !$PSBoundParameters.ContainsKey('SecretAccessKey')) {
        $AccessKeyId = ''; $SecretAccessKey = ''
    }
    try {
        if ($PSBoundParameters.ContainsKey('AccessKeyId') -xor $PSBoundParameters.ContainsKey('SecretAccessKey')) { Stop-R2Distribution 'credentials' 'invalid-input' }
        if ($AccountId -cnotmatch '^[a-f0-9]{32}$' -or $Bucket -cnotmatch '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$') { Stop-R2Distribution $phase 'invalid-input' }
        $resolved = (Resolve-Path -LiteralPath $FilePath -ErrorAction Stop).ProviderPath
        if (!$Key) { $Key = [IO.Path]::GetFileName($resolved) }
        # URI の dot-segment 正規化で署名と対象がずれないよう曖昧なキーを拒否する。
        if (!$Key -or $Key.StartsWith('/') -or $Key -match '[\x00-\x1f\x7f\\]' -or @($Key.Split('/') | Where-Object { $_ -in @('.', '..') }).Count -gt 0) { Stop-R2Distribution $phase 'invalid-key' }
        if (!$CacheControl) { $CacheControl = if ($Immutable) { 'public, max-age=31536000, immutable' } else { 'no-cache' } }
        if ($CacheControl -match '[\r\n]' -or $ContentType -match '[\r\n]') { Stop-R2Distribution $phase 'invalid-input' }
        $mediaType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType)
        if ($PSBoundParameters.ContainsKey('ExpectedETag')) {
            if (!$ExpectedETag -or $Immutable -or ([Net.Http.Headers.EntityTagHeaderValue]::Parse($ExpectedETag)).IsWeak -or $ExpectedETag -eq '*') { Stop-R2Distribution $phase 'invalid-input' }
        }
        # この handle を hash・upload・最終確認まで保持し、書込みと削除を許さない。
        $file = [IO.File]::Open($resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $size = $file.Length; $hash = Get-R2DistributionHash $file
        $canonicalPath = '/' + $Bucket + '/' + (($Key.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/')
        $uri = [uri]("https://$AccountId.r2.cloudflarestorage.com" + $canonicalPath)
        $client = New-R2DistributionClient
        $phase = 'credentials'
        $credentials = Get-R2DistributionCredentials $client $AccountId $ApiToken $AccessKeyId $SecretAccessKey
        $phase = 'head'
        $empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        $request = New-R2DistributionRequest 'HEAD' $uri $canonicalPath $empty $credentials
        $response = Send-R2DistributionRequest $client $request $phase
        $status = [int]$response.StatusCode; $etag = [string]$response.Headers.ETag
        $response.Dispose(); $response = $null; $request.Dispose(); $request = $null
        if ($status -notin @(200,404)) { Stop-R2Distribution $phase 'http-rejected' $status }
        if ($ExpectedETag -and ($status -ne 200 -or $etag -cne $ExpectedETag)) { Stop-R2Distribution $phase 'concurrent-change' }
        $changed = $false; $publishedETag = ''
        if (!($Immutable -and $status -eq 200)) {
            $phase = 'put'
            $headers = @{ 'cache-control' = $CacheControl }
            if ($status -eq 404 -or $Immutable) { $headers['if-none-match'] = '*' }
            else {
                if (!$etag -or $etag.StartsWith('W/')) { Stop-R2Distribution $phase 'missing-strong-etag' }
                $headers['if-match'] = if ($ExpectedETag) { $ExpectedETag } else { $etag }
            }
            $put = New-R2DistributionRequest 'PUT' $uri $canonicalPath $hash $credentials $headers
            $put.Content = [Net.Http.StreamContent]::new($file, 65536)
            $put.Content.Headers.ContentLength = $size
            $put.Content.Headers.ContentType = $mediaType
            $response = Send-R2DistributionRequest $client $put $phase
            $status = [int]$response.StatusCode
            $publishedETag = [string]$response.Headers.ETag
            $response.Dispose(); $response = $null
            if ($status -eq 412 -and !$Immutable) { Stop-R2Distribution $phase 'concurrent-change' $status }
            if ($status -ne 200 -and !($Immutable -and $status -eq 412)) {
                if ($status -ge 400 -and $status -lt 500) { Stop-R2Distribution $phase 'http-rejected' $status }
                Stop-R2Distribution $phase 'unknown-no-resend' $status
            }
            $changed = $status -eq 200
            if ($changed -and (!$publishedETag -or $publishedETag.StartsWith('W/'))) { Stop-R2Distribution $phase 'missing-strong-etag' }
        }
        $phase = 'verify'
        $etag = Assert-R2DistributionRemote $client $uri $canonicalPath $credentials $size $hash $publishedETag
        if ($file.Length -ne $size -or (Get-R2DistributionHash $file) -cne $hash) { Stop-R2Distribution $phase 'local-file-changed' }
        return [pscustomobject]@{ Key = $Key; ETag = $etag; SHA256 = $hash; Size = $size; Changed = $changed }
    } catch {
        # 外部例外のメッセージ・inner exception・HTTP body に機密値があっても返さない。
        $failure = $_.Exception
        while ($null -ne $failure) {
            if ($failure.Data['R2DistributionSafe'] -eq $true -and $failure.Message -cmatch '^R2 transfer stopped: phase=[a-z-]+ code=([a-z-]+)(?: httpStatus=([1-5][0-9]{2}))?$') {
                Stop-R2Distribution $phase $Matches[1] $(if ($Matches[2]) { [int]$Matches[2] } else { 0 })
            }
            $failure = $failure.InnerException
        }
        Stop-R2Distribution $phase 'operation-failed'
    } finally {
        if ($null -ne $response) { $response.Dispose() }; if ($null -ne $request) { $request.Dispose() }
        if ($null -ne $put) { $put.Dispose() }; if ($null -ne $file) { $file.Dispose() }; if ($null -ne $client) { $client.Dispose() }
        $credentials = $null; $ApiToken = $null; $AccessKeyId = $null; $SecretAccessKey = $null
    }
}
