<#
.SYNOPSIS
  Adds/updates a hosts-file entry so THIS machine resolves the shared host
  record to a LAN IP instead of its public IP.

.DESCRIPTION
  A per-machine workaround for NAT hairpinning when you don't run a local DNS
  server. See the README's Troubleshooting section for background and the
  local-DNS-override alternative, which fixes every device on the LAN instead
  of just this one.

  Safe to re-run: it replaces its own previously-added block instead of
  duplicating it. Re-run it if the host's LAN IP changes - this does not
  track that automatically. Must be run from an elevated (Administrator)
  PowerShell prompt, since it edits the hosts file.

.PARAMETER HostRecord
  The shared host record shown as "Generated host record" on the DNS settings
  page, e.g. factorio-stack-manager.mydomain.com

.PARAMETER LanIp
  The manager host's LAN IP address, e.g. 192.168.1.50

.EXAMPLE
  .\add-host-entry.ps1 -HostRecord factorio-stack-manager.mydomain.com -LanIp 192.168.1.50
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$HostRecord,

    [Parameter(Mandatory = $true, Position = 1)]
    [string]$LanIp
)

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated (Administrator) PowerShell prompt - it edits the hosts file."
    exit 1
}

if ($HostRecord -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)+[A-Za-z0-9-]{1,63}$') {
    Write-Error "'$HostRecord' doesn't look like a valid hostname."
    exit 1
}
$octet = '(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
if ($LanIp -notmatch "^$octet\.$octet\.$octet\.$octet$") {
    Write-Error "'$LanIp' doesn't look like a valid IPv4 address."
    exit 1
}

$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$markerBegin = "# BEGIN factorio-stack-manager ($HostRecord)"
$markerEnd = "# END factorio-stack-manager ($HostRecord)"
# Pre-rebrand marker: recognized so a re-run of this (updated) script still finds
# and replaces a block an older version of it wrote, instead of leaving that one
# behind and duplicating the entry. Never written going forward.
$legacyMarkerBegin = "# BEGIN factorio-tools-manager ($HostRecord)"
$legacyMarkerEnd = "# END factorio-tools-manager ($HostRecord)"

$lines = @(Get-Content -Path $hostsPath)

if (($lines | Select-String -SimpleMatch $HostRecord) -and
    -not ($lines -contains $markerBegin) -and
    -not ($lines -contains $legacyMarkerBegin)) {
    Write-Warning "$HostRecord already appears in $hostsPath outside this script's managed block. The first matching line wins, so check for conflicts if the override doesn't take effect."
}

$filtered = New-Object System.Collections.Generic.List[string]
$skipping = $false
foreach ($line in $lines) {
    if ($line -eq $markerBegin -or $line -eq $legacyMarkerBegin) { $skipping = $true; continue }
    if ($line -eq $markerEnd -or $line -eq $legacyMarkerEnd) { $skipping = $false; continue }
    if (-not $skipping) { $filtered.Add($line) }
}

while ($filtered.Count -gt 0 -and $filtered[$filtered.Count - 1] -eq '') {
    $filtered.RemoveAt($filtered.Count - 1)
}

$backupPath = "$hostsPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
Copy-Item -Path $hostsPath -Destination $backupPath

$filtered.Add('')
$filtered.Add($markerBegin)
$filtered.Add("$LanIp`t$HostRecord")
$filtered.Add($markerEnd)

Set-Content -Path $hostsPath -Value $filtered -Encoding ASCII

Write-Host "Added: $LanIp -> $HostRecord in $hostsPath (backup saved at $backupPath)"
Write-Host "If the change doesn't take effect immediately, run: ipconfig /flushdns"
