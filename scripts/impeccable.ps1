param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $TaskArguments
)

$ErrorActionPreference = 'Stop'
$taskEngineVersion = '0.1.5'
$taskEnginePath = Join-Path $env:USERPROFILE ".impeccable\bin\$taskEngineVersion\impeccable.exe"
if (-not (Test-Path -LiteralPath $taskEnginePath -PathType Leaf)) {
  throw "Impeccable engine $taskEngineVersion is missing. Restore the Impeccable plugin and run its scripts/impeccable.cmd engine-probe with network and cache write access."
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
  & $taskEnginePath @TaskArguments
  $taskResult = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $taskResult
