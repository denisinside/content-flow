param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CliArguments = @('--help')
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$cliPath = Join-Path $projectRoot '.local-checks/difyctl/1.17.1/difyctl.exe'
$expectedHash = '13d38e0a0061eec6e25cfdf3aa287743d468d186a09621fa92de3550a1dc96e0'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw 'Project-local difyctl1.17.1 is missing. See docs/DIFYCTL_SETUP.md.'
}
if ((Get-FileHash -LiteralPath $cliPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
  throw 'Project-local difyctl1.17.1 checksum does not match the official release.'
}

# This isolates host metadata only. OAuth tokens use Windows Credential Manager
# when available; DIFY_CONFIG_DIR does not relocate the OS credential store.
$previousConfig = $env:DIFY_CONFIG_DIR
try {
  $env:DIFY_CONFIG_DIR = Join-Path $projectRoot '.local-checks/difyctl/config'
  & $cliPath @CliArguments
  if ($LASTEXITCODE -ne 0) { throw "difyctl exited with code $LASTEXITCODE" }
} finally {
  $env:DIFY_CONFIG_DIR = $previousConfig
}
