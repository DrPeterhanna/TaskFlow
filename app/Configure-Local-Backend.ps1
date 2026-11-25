$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$destination = Join-Path $PSScriptRoot '.env.local'
if (Test-Path $destination) { throw '.env.local already exists. It was NOT overwritten. Review it yourself before rebuilding.' }
@'
EXPO_PUBLIC_TASKFLOW_ENV=local
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
EXPO_PUBLIC_SUPABASE_KEY=taskflow-local-development-only
'@ | Set-Content -Encoding Ascii $destination
Write-Host 'Local-only build config written. No backend started, no database contacted. Rebuild the APK.'
