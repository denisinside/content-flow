param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $TaskArguments
)
$ErrorActionPreference = 'Stop'
$taskBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$taskNode = if (Test-Path -LiteralPath $taskBundledNode) { $taskBundledNode } else { (Get-Command node).Source }
$taskVersion = & $taskNode --version
if ([Version]($taskVersion.TrimStart('v')) -lt [Version]'24.19.0' -or [Version]($taskVersion.TrimStart('v')) -ge [Version]'25.0.0') {
  throw 'ContextFlow requires Node 24 >=24.19.0. Install the pinned runtime or use the Codex bundled Node24.'
}
$env:PATH = [System.IO.Path]::GetDirectoryName($taskNode) + [System.IO.Path]::PathSeparator + $env:PATH
Push-Location (Join-Path $PSScriptRoot '..')
try {
  & pnpm @TaskArguments
  exit $LASTEXITCODE
} finally { Pop-Location }
