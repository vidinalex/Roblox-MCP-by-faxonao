[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(Mandatory = $true)]
  [string]$PatchFile,

  [string]$ExpectedHash,

  [string]$PlaceId,

  [switch]$DryRun,

  [int]$Port = 0,

  [string]$HostName = "127.0.0.1"
)

if (-not (Test-Path -LiteralPath $PatchFile)) {
  throw "Patch file not found: $PatchFile"
}

$patchRaw = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $PatchFile), [System.Text.Encoding]::UTF8)
$patch = $patchRaw | ConvertFrom-Json
$payload = @{
  path = $Path
  patch = $patch
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedHash)) {
  $payload.expectedHash = $ExpectedHash
}
if (-not [string]::IsNullOrWhiteSpace($PlaceId)) {
  $payload.placeId = $PlaceId
}
if ($DryRun.IsPresent) {
  $payload.dryRun = $true
}

$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("rbxmcp-patch-{0}.json" -f [guid]::NewGuid().ToString("N"))
try {
  [System.IO.File]::WriteAllText(
    $tempFile,
    ($payload | ConvertTo-Json -Depth 16 -Compress),
    [System.Text.UTF8Encoding]::new($false)
  )
  & "$PSScriptRoot\rbxmcp-post.ps1" -Endpoint "/v1/agent/apply_script_patch" -JsonFile $tempFile -Port $Port -HostName $HostName
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
