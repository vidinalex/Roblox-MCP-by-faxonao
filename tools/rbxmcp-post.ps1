[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Endpoint,

  [string]$JsonFile,

  [string]$Method = "POST",

  [int]$Port = 0,

  [string]$HostName = "127.0.0.1"
)

$effectivePort = if ($Port -gt 0) { $Port } elseif ($env:RBXMCP_PORT) { [int]$env:RBXMCP_PORT } else { 5100 }
$requestScript = Join-Path $PSScriptRoot "rbxmcp-request.mjs"
if (-not (Test-Path -LiteralPath $requestScript)) {
  throw "Request helper not found: $requestScript"
}

if ($JsonFile) {
  if (-not (Test-Path -LiteralPath $JsonFile)) {
    throw "JSON file not found: $JsonFile"
  }
  & node $requestScript --endpoint $Endpoint --method $Method --host $HostName --port $effectivePort --file $JsonFile
  exit $LASTEXITCODE
}

$stdinText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($stdinText)) {
  if ($Method.ToUpperInvariant() -eq "GET") {
    & node $requestScript --endpoint $Endpoint --method GET --host $HostName --port $effectivePort
    exit $LASTEXITCODE
  }
  throw "Provide -JsonFile or pipe JSON through stdin."
}

$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("rbxmcp-{0}.json" -f [guid]::NewGuid().ToString("N"))
try {
  [System.IO.File]::WriteAllText($tempFile, $stdinText, [System.Text.UTF8Encoding]::new($false))
  & node $requestScript --endpoint $Endpoint --method $Method --host $HostName --port $effectivePort --file $tempFile
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
