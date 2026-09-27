# Cosimo installer for Windows (x64).
#
#   irm https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.ps1 | iex
#
# Downloads cosimo-windows-x64.exe from GitHub Releases, verifies its SHA-256
# against checksums.txt, installs it to %LOCALAPPDATA%\Programs\cosimo, adds
# that folder to your user PATH if missing, then runs `cosimo.exe init`.
#
# `irm | iex` cannot pass arguments, so for automation either download the
# script and run it with arguments (they are passed to `cosimo init`):
#
#   & ([scriptblock]::Create((irm https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.ps1))) --answers .\answers.json --yes --json
#
# or configure it with environment variables:
#   COSIMO_VERSION        Release to install (default: latest; e.g. 0.1.0)
#   COSIMO_INSTALL_DIR    Install directory (default: %LOCALAPPDATA%\Programs\cosimo)
#   COSIMO_DOWNLOAD_BASE  Base URL holding the release assets (mirrors/tests)
#   COSIMO_NO_INIT=1      Install only; do not run `cosimo init`
#   COSIMO_INIT_ARGS      Arguments for `cosimo init` when none are passed (space separated)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Mirrors packages/shared/src/distribution.ts
$GitHubRepo = 'lomnes-atlast-food/cosimo'
$ReleasesBaseUrl = "https://github.com/$GitHubRepo/releases"
$Asset = 'cosimo-windows-x64.exe'

# Under `irm | iex` there is no script file, and `exit` would close the
# user's PowerShell window, so only exit when run as a .ps1 file.
$RunAsFile = [bool]$MyInvocation.MyCommand.Path

function Say([string]$Message) { Write-Host "cosimo-install: $Message" }
function Fail([string]$Message) {
  Write-Host "cosimo-install: error: $Message" -ForegroundColor Red
  if ($RunAsFile) { exit 1 }
  throw "cosimo-install failed: $Message"
}

# 1. Detect architecture.
$arch = $env:PROCESSOR_ARCHITEW6432
if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { Fail "unsupported architecture '$arch' (only Windows x64 is supported)" }
Say "detected platform windows/x64; release asset $Asset"

$version = if ($env:COSIMO_VERSION) { $env:COSIMO_VERSION } else { 'latest' }
if ($env:COSIMO_DOWNLOAD_BASE) {
  $base = $env:COSIMO_DOWNLOAD_BASE.TrimEnd('/')
} elseif ($version -eq 'latest') {
  $base = "$ReleasesBaseUrl/latest/download"
} else {
  $base = "$ReleasesBaseUrl/download/v$($version.TrimStart('v'))"
}

$installDir = if ($env:COSIMO_INSTALL_DIR) { $env:COSIMO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\cosimo' }
$exe = Join-Path $installDir 'cosimo.exe'

# 2. Download the binary and checksums to a temp folder.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("cosimo-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  foreach ($name in @($Asset, 'checksums.txt')) {
    Say "downloading $base/$name"
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile (Join-Path $tmp $name) }
    catch { Fail "download of $name failed: $($_.Exception.Message)" }
  }

  # 3. Verify SHA-256. (Signature verification of checksums.txt needs cosign;
  # see scripts/README.md to verify manually.)
  Say "note: signature not checked by this script (checksum is still verified; files fetched over HTTPS)"
  $expected = $null
  foreach ($line in Get-Content (Join-Path $tmp 'checksums.txt')) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 2 -and ($parts[1] -eq $Asset -or $parts[1] -eq "*$Asset")) { $expected = $parts[0].ToLower(); break }
  }
  if (-not $expected) { Fail "no checksum for $Asset in checksums.txt; not installing" }
  $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $Asset)).Hash.ToLower()
  if ($actual -ne $expected) { Fail "checksum mismatch for $Asset (expected $expected, got $actual); not installing" }
  Say "checksum OK (sha256 $actual)"

  # 4. Install.
  Say "installing to $exe"
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Move-Item -Force -Path (Join-Path $tmp $Asset) -Destination $exe
  Say "installed $exe"
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ })
if ($entries -notcontains $installDir) {
  Say "adding $installDir to your user PATH (open a new terminal for it to take effect)"
  [Environment]::SetEnvironmentVariable('Path', (($entries + $installDir) -join ';'), 'User')
}
if (($env:Path -split ';') -notcontains $installDir) { $env:Path = "$installDir;$env:Path" }

# 5. Run `cosimo init`.
if ($env:COSIMO_NO_INIT -eq '1') {
  Say "skipping 'cosimo init' (COSIMO_NO_INIT=1). Run it later with: cosimo init"
  if ($RunAsFile) { exit 0 }
  return
}
$initArgs = @($args)
if ($initArgs.Count -eq 0 -and $env:COSIMO_INIT_ARGS) { $initArgs = @($env:COSIMO_INIT_ARGS -split '\s+' | Where-Object { $_ }) }
Say "running: $exe init $($initArgs -join ' ')"
& $exe init @initArgs
if ($RunAsFile) { exit $LASTEXITCODE }
