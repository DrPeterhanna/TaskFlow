$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL2 is required. Read WINDOWS-SETUP.md. Nothing was installed or changed.' }
$distros = (& wsl.exe --list --quiet) -replace "`0", ''
if (-not ($distros -match '^Ubuntu$')) { throw 'Ubuntu WSL distribution not found. Read WINDOWS-SETUP.md. No install was attempted.' }
$version = (& wsl.exe -d Ubuntu -- uname -r)
if ($LASTEXITCODE -ne 0 -or $version -notmatch 'WSL2|microsoft-standard') { throw 'Ubuntu must run under WSL2. Read WINDOWS-SETUP.md.' }
$linuxPath = (& wsl.exe -d Ubuntu -- wslpath -u $PSScriptRoot).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not translate package path to WSL.' }
& wsl.exe -d Ubuntu -- bash "$linuxPath/start-wsl.sh"
if ($LASTEXITCODE -ne 0) { throw 'Backend stopped with an error. Keep this window open and report its last error.' }
