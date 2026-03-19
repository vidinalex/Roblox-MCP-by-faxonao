[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [string]$InputFile,

  [switch]$NoClobber
)

$resolvedPath = [System.IO.Path]::GetFullPath($Path)
$parent = [System.IO.Path]::GetDirectoryName($resolvedPath)
if (-not [string]::IsNullOrWhiteSpace($parent)) {
  [System.IO.Directory]::CreateDirectory($parent) | Out-Null
}

if ($NoClobber -and (Test-Path -LiteralPath $resolvedPath)) {
  throw "Target file already exists: $resolvedPath"
}

if (-not [string]::IsNullOrWhiteSpace($InputFile)) {
  if (-not (Test-Path -LiteralPath $InputFile)) {
    throw "Input file not found: $InputFile"
  }
  [System.IO.File]::Copy((Resolve-Path -LiteralPath $InputFile), $resolvedPath, $true)
  exit 0
}

$stdinText = [Console]::In.ReadToEnd()
[System.IO.File]::WriteAllText($resolvedPath, $stdinText, [System.Text.UTF8Encoding]::new($false))
