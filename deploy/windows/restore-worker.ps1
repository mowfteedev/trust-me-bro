#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Restore only changes tracked by setup-worker.ps1; retains files/user/host keys. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'ZT-ServerOps\worker'
$statePath = Join-Path $root 'setup-state.json'
. (Join-Path $PSScriptRoot 'worker-common.ps1')
foreach ($managed in @((Split-Path -Parent $root), $root, $statePath)) { Assert-TrustedManagedPath $managed }
if (-not (Test-Path -LiteralPath $statePath)) { throw 'No setup state exists; no changes made.' }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
Assert-WorkerState $state $root
Assert-TrustedManagedPath $state.ConfigPath
Assert-TrustedManagedPath $state.BackupPath
Assert-TrustedManagedPath (Split-Path -Parent $state.ConfigPath)
if ($state.HadConfig -and -not (Test-Path -LiteralPath $state.BackupPath -PathType Leaf)) { throw 'Required original sshd backup is missing; no restore actions taken.' }
Stop-Service -Name sshd -ErrorAction SilentlyContinue
foreach ($name in $state.RuleNames) {
    if ($name -notin @('ZT-ServerOps-SSH-VPN', 'ZT-ServerOps-SSH-Transport-Block')) { throw 'Unexpected rule name in state; restore manually.' }
    Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
if ($state.HadConfig) {
    Copy-Item -LiteralPath $state.BackupPath -Destination $state.ConfigPath -Force
} elseif (Test-Path -LiteralPath $state.ConfigPath) {
    Remove-Item -LiteralPath $state.ConfigPath
}
$dependencies = @($state.SshdDependencies) -join '/'
if (-not $dependencies) { $dependencies = '/' }
& "$env:WINDIR\System32\sc.exe" config sshd depend= $dependencies *> $null
if ($LASTEXITCODE -ne 0) { throw 'Could not restore sshd dependencies; state retained.' }
switch ($state.SshdStartMode) {
    'Auto' { Set-Service -Name sshd -StartupType Automatic }
    'Manual' { Set-Service -Name sshd -StartupType Manual }
    'Disabled' { Set-Service -Name sshd -StartupType Disabled }
    default { throw 'Unrecognized previous sshd startup type; review manually.' }
}
if ($state.SshdWasRunning) { Start-Service -Name sshd }
if ($state.TunnelInstalled) {
    if ($state.TunnelName -ne 'zt-worker') { throw 'Unexpected tunnel name; preserve and review manually.' }
    $wireguard = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
    if (Get-Service -Name ('WireGuardTunnel$' + $state.TunnelName) -ErrorAction SilentlyContinue) {
        $tunnelProcess = Start-Process -FilePath $wireguard -ArgumentList @('/uninstalltunnelservice', $state.TunnelName) -Wait -PassThru
        if ($tunnelProcess.ExitCode -ne 0) { throw 'Could not remove the ZT tunnel service; state retained.' }
    }
}
$suffix = '.restored-' + (Get-Date -Format 'yyyyMMddHHmmss')
Assert-TrustedManagedPath ($state.BackupPath + $suffix)
Assert-TrustedManagedPath ($statePath + $suffix)
if ($state.HadConfig) { Move-Item -LiteralPath $state.BackupPath -Destination ($state.BackupPath + $suffix) }
Move-Item -LiteralPath $statePath -Destination ($statePath + $suffix)
Write-Host 'ZT-owned rules/tunnel removed; previous sshd config/service state restored. Files, host keys and the local account were retained.'
Write-Host 'Gateway DB registration/peer and the Agent service were not modified by this restore.'
