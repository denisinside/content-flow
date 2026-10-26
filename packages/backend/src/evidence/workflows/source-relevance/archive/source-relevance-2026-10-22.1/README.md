# Archived source relevance release 2026-10-22.1

This directory is a read-only snapshot of the historical `source-relevance-2026-10-22.1` release: its prompt, native Dify YAML, release descriptor, README and adjacent copy of the Code-node runtime. The YAML targeted Dify `1.17.1`, Graphon `0.7.0` and DSL `0.7.0`; it used the verbose model protocol that echoed candidate IDs and quote hashes.

The current builder and verifier describe release `source-relevance-2026-10-24.1` and do not reproduce or validate this archived release. Do not run the builder to regenerate the archived YAML. The archived descriptor's `runtimeFile` retains the historical repository-relative path `scripts/dify/source_relevance_runtime.py`; in this archive, use the adjacent `source_relevance_runtime.py` copy whose bytes were included in the old release hash.

## Check archived file hashes

Run this PowerShell snippet from the repository root. It resolves the prompt, DSL and runtime beside this descriptor and compares their SHA-256 values with the unchanged archived descriptor:

```powershell
$archive = 'packages/backend/src/evidence/workflows/source-relevance/archive/source-relevance-2026-10-22.1'
$release = Get-Content (Join-Path $archive 'release.json') -Raw | ConvertFrom-Json
$checks = @(
  @{ field = 'promptSha256'; file = $release.promptTemplateFile },
  @{ field = 'workflowDslSha256'; file = $release.workflowDslFile },
  @{ field = 'runtimeSha256'; file = 'source_relevance_runtime.py' }
)
foreach ($check in $checks) {
  $path = Join-Path $archive $check.file
  $expected = $release.($check.field)
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Archive hash mismatch: $($check.field)" }
  "PASS $($check.field)"
}
```

This verifies the preserved local files only. It does not verify the historical remote Dify app or prove its current publication state.
