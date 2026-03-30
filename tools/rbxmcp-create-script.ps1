[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(Mandatory = $true)]
  [string]$SourceFile,

  [ValidateSet("Script", "LocalScript", "ModuleScript")]
  [string]$ClassName = "ModuleScript",

  [string]$PlaceId,

  [int]$Port = 0,

  [string]$HostName = "127.0.0.1"
)

if (-not (Test-Path -LiteralPath $SourceFile)) {
  throw "Source file not found: $SourceFile"
}

$resolvedSourceFile = (Resolve-Path -LiteralPath $SourceFile)
$sourceBytes = [System.IO.File]::ReadAllBytes($resolvedSourceFile)
$payload = @{
  path = $Path
  className = $ClassName
  sourceBase64 = [System.Convert]::ToBase64String($sourceBytes)
}

if (-not [string]::IsNullOrWhiteSpace($PlaceId)) {
  $payload.placeId = $PlaceId
}

$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("rbxmcp-create-{0}.json" -f [guid]::NewGuid().ToString("N"))
try {
  [System.IO.File]::WriteAllText(
    $tempFile,
    ($payload | ConvertTo-Json -Depth 8 -Compress),
    [System.Text.UTF8Encoding]::new($false)
  )
  & "$PSScriptRoot\rbxmcp-post.ps1" -Endpoint "/v1/agent/create_script" -JsonFile $tempFile -Port $Port -HostName $HostName
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
