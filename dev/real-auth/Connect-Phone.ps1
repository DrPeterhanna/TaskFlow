$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:54321/health' -TimeoutSec 5
if (-not $health.ok) { throw 'Windows cannot reach a healthy WSL backend. Do not connect the phone yet.' }
Write-Host 'Windows -> WSL Auth/API: healthy'
$adb = (Get-Command adb.exe -ErrorAction SilentlyContinue).Source
if (-not $adb) {
  $adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
}
if (-not (Test-Path $adb)) { throw 'Android platform-tools adb.exe not found. Read WINDOWS-SETUP.md.' }
$devices = @((& $adb devices) | Select-String '^\S+\s+device$')
if ($devices.Count -ne 1) { & $adb devices; throw 'Connect exactly one phone by USB, unlock it and approve USB debugging.' }
$serial = ($devices[0].ToString() -split '\s+')[0]
& $adb -s $serial reverse tcp:54321 tcp:54321
if ($LASTEXITCODE -ne 0) { throw 'ADB reverse failed.' }
$rules = & $adb -s $serial reverse --list
$rules
if (-not ($rules -match 'tcp:54321 tcp:54321')) { throw 'ADB reverse rule not confirmed.' }
Write-Host 'ADB rule installed. Phone-to-backend remains unverified until the app signs in and creates a task.'
Write-Host 'Keep the USB cable and backend window connected. Run again after reconnecting.'
