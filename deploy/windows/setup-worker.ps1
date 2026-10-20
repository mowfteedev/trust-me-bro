#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
Run from the local console of a dedicated Windows 10/11 or Server 2022 VM, after installing
official WireGuard and the Windows OpenSSH Server optional capability.
Creates only named ZT firewall rules; preserves other rules and saves sshd config.
The transport NICs must use NAT with NO inbound port forwarding.
This script is not proof of Internet isolation; run check-worker + external probes.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TunnelConfigPath,
    [Parameter(Mandatory = $true)][string]$GatewaySshPublicKeyPath,
    [Parameter(Mandatory = $true)][string[]]$TransportInterfaceAlias,
    [string]$VpnAddress = '10.100.0.3',
    [string]$GatewayVpnAddress = '10.100.0.1',
    [ValidatePattern('^[a-z][a-z0-9_-]{0,19}$')][string]$SshUser = 'ztuser',
    [switch]$DedicatedVm
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tunnelName = 'zt-worker'
$root = Join-Path $env:ProgramData 'ZT-ServerOps\worker'
$statePath = Join-Path $root 'setup-state.json'
$sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
$keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
$wireguard = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
$configPath = Join-Path $env:ProgramData 'ssh\sshd_config'
. (Join-Path $PSScriptRoot 'worker-common.ps1')

function Set-PrivateAcl([string]$Path, [string]$ReaderSid = '') {
    Assert-NoReparsePoint $Path
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($entry in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($entry) }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($ReaderSid) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($ReaderSid)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'ReadAndExecute', 'Allow')
        $acl.AddAccessRule($rule)
    }
    $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if (-not $DedicatedVm) { throw 'Use -DedicatedVm only at the console of the dedicated lab VM. Existing sshd configuration will be backed up and replaced.' }
foreach ($managed in @((Split-Path -Parent $root), $root, $statePath, $configPath, (Split-Path -Parent $configPath))) { Assert-TrustedManagedPath $managed }
foreach ($inputPath in @($TunnelConfigPath, $GatewaySshPublicKeyPath, $sshd, $keygen, $wireguard)) { Assert-NoReparsePoint $inputPath }
if (Test-Path -LiteralPath $statePath) { throw 'Setup state already exists. Run check-worker.ps1 or restore-worker.ps1; do not overwrite it.' }
foreach ($file in @($TunnelConfigPath, $GatewaySshPublicKeyPath, $sshd, $keygen, $wireguard)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'A required input or installed OpenSSH/WireGuard executable is missing.' }
}
foreach ($address in @($VpnAddress, $GatewayVpnAddress)) {
    $parsed = [System.Net.IPAddress]::Parse($address)
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'Use IPv4 overlay addresses.' }
}
if ($VpnAddress -eq $GatewayVpnAddress) { throw 'Worker and Gateway addresses must differ.' }
$tunnel = Get-Content -LiteralPath $TunnelConfigPath -Raw
if ($tunnel -notmatch ('(?m)^\s*Address\s*=\s*' + [regex]::Escape($VpnAddress) + '/32\s*$') -or
    $tunnel -notmatch ('(?m)^\s*AllowedIPs\s*=\s*' + [regex]::Escape($GatewayVpnAddress) + '/32\s*$')) {
    throw 'Tunnel must use the explicit worker /32 and route only the Gateway /32.'
}
$publicKey = (Get-Content -LiteralPath $GatewaySshPublicKeyPath -Raw).Trim()
if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\r\n]*)?$') { throw 'Expected one Ed25519 PUBLIC key.' }
$user = Get-LocalUser -Name $SshUser
if (-not $user.Enabled) { throw 'SSH user must be an enabled local account.' }
$adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
if (@(Get-LocalGroupMember -Group $adminGroup | Where-Object { $_.SID -eq $user.SID }).Count) { throw 'SSH user must not be an administrator.' }
if ((Get-CimInstance Win32_ComputerSystem).PartOfDomain) { throw 'This small setup targets a workgroup lab VM; domain policy requires manual review.' }
Assert-FirewallProfiles (@($TransportInterfaceAlias) + @($tunnelName))
foreach ($alias in $TransportInterfaceAlias) {
    if ($alias -eq $tunnelName -or $alias -match '[*?\[\]]') { throw 'Use exact transport NIC names, excluding WireGuard.' }
    [void](Get-NetAdapter -Name $alias -ErrorAction Stop)
}
$unlisted = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.Name -ne $tunnelName -and $_.Name -notin $TransportInterfaceAlias })
if ($unlisted.Count) { throw 'List every active transport NIC explicitly; an unlisted NIC would bypass the intended SSH rule scope.' }
if (Get-Service -Name ('WireGuardTunnel$' + $tunnelName) -ErrorAction SilentlyContinue) { throw 'A zt-worker tunnel already exists. Preserve it and review manually.' }
$service = Get-CimInstance Win32_Service -Filter "Name='sshd'"
if (-not $service) { throw 'Install the Windows OpenSSH Server optional capability first.' }
$ruleNames = @('ZT-ServerOps-SSH-VPN', 'ZT-ServerOps-SSH-Transport-Block')
if (@(Get-NetFirewallRule -Name $ruleNames -ErrorAction SilentlyContinue).Count) { throw 'ZT firewall rule names already exist; preserve and review them.' }

# Secure the shared parent before creating children so a standard user cannot
# pre-create/replace an elevated file destination between later operations.
$parentRoot = Split-Path -Parent $root
if (-not (Test-Path -LiteralPath $parentRoot)) { New-Item -Path $parentRoot -ItemType Directory | Out-Null }
Set-PrivateAcl $parentRoot 'S-1-5-19'
if (-not (Test-Path -LiteralPath $root)) { New-Item -Path $root -ItemType Directory | Out-Null }
Set-PrivateAcl $root
$backupPath = Join-Path $root 'sshd_config.before-zt'
foreach ($managed in @($backupPath, (Join-Path $root 'zt-worker.conf'), (Join-Path $root 'authorized_keys'), (Join-Path $root 'ssh_host_ed25519_key.pub'))) { Assert-TrustedManagedPath $managed }
$hadConfig = Test-Path -LiteralPath $configPath
if ($hadConfig) { Copy-Item -LiteralPath $configPath -Destination $backupPath; Set-PrivateAcl $backupPath }
$state = @{
    ConfigPath = $configPath; BackupPath = $backupPath; HadConfig = $hadConfig
    SshdStartMode = $service.StartMode; SshdWasRunning = ($service.State -eq 'Running')
    SshdDependencies = @((Get-Service -Name sshd).ServicesDependedOn | Select-Object -ExpandProperty Name)
    RuleNames = $ruleNames; TunnelName = $tunnelName; TunnelInstalled = $false
    TransportInterfaces = $TransportInterfaceAlias; VpnAddress = $VpnAddress
    GatewayVpnAddress = $GatewayVpnAddress; SshUser = $SshUser
}
$state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
Set-PrivateAcl $statePath
try {
    $privateTunnel = Join-Path $root ($tunnelName + '.conf')
    # Create with protected ACL before writing any private key material.
    if (-not (Test-Path -LiteralPath $privateTunnel)) { New-Item -Path $privateTunnel -ItemType File | Out-Null }
    Set-PrivateAcl $privateTunnel
    [System.IO.File]::WriteAllText($privateTunnel, $tunnel, (New-Object System.Text.UTF8Encoding($false)))
    # The tunnel did not exist during preflight; record ownership before invoking
    # native setup so even a partially failed installation remains reversible.
    $state.TunnelInstalled = $true
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
    & $wireguard /installtunnelservice $privateTunnel *> $null
    if ($LASTEXITCODE -ne 0) { throw 'WireGuard service installation failed.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $vpn = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $VpnAddress -and $_.InterfaceAlias -eq $tunnelName })
        if ($vpn.Count) { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'WireGuard did not create the expected interface/address.' }
        Start-Sleep -Milliseconds 200
    } while ($true)

    $authorizedPath = Join-Path $root 'authorized_keys'
    if (-not (Test-Path -LiteralPath $authorizedPath)) { New-Item -Path $authorizedPath -ItemType File | Out-Null }
    Set-PrivateAcl $authorizedPath $user.SID.Value
    [System.IO.File]::WriteAllText($authorizedPath, $publicKey + "`n", (New-Object System.Text.UTF8Encoding($false)))
    # User needs traversal/read on the directory, but cannot modify keys/config.
    Set-PrivateAcl $root $user.SID.Value
    $hostKey = Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key'
    Assert-TrustedManagedPath $hostKey
    Assert-TrustedManagedPath ($hostKey + '.pub')
    & $keygen -A *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $hostKey)) { throw 'Host key generation failed.' }
    # A key created by an administrator must also pass sshd's checks as SYSTEM.
    Set-PrivateAcl $hostKey
    $sshConfig = @"
Port 22
AddressFamily inet
ListenAddress $VpnAddress
HostKey $($hostKey.Replace('\', '/'))
PubkeyAuthentication yes
PasswordAuthentication no
AuthenticationMethods publickey
AuthorizedKeysFile $($authorizedPath.Replace('\', '/'))
AllowUsers $SshUser@$GatewayVpnAddress
AllowTcpForwarding no
AllowAgentForwarding no
GatewayPorts no
PermitTTY yes
MaxAuthTries 3
LoginGraceTime 30
LogLevel VERBOSE
"@
    Stop-Service -Name sshd -ErrorAction Stop
    [System.IO.File]::WriteAllText($configPath, $sshConfig + "`n", (New-Object System.Text.UTF8Encoding($false)))
    & $sshd -t -f $configPath *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Installed OpenSSH rejected configuration; restore before trying again.' }
    New-NetFirewallRule -Name $ruleNames[0] -DisplayName 'ZT SSH via Gateway VPN only' -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalPort 22 -LocalAddress $VpnAddress -RemoteAddress $GatewayVpnAddress -InterfaceAlias $tunnelName | Out-Null
    # No LocalAddress restriction: this blocks TCP/22 on both IPv4 and IPv6 transport.
    New-NetFirewallRule -Name $ruleNames[1] -DisplayName 'ZT block SSH on transport NICs' -Direction Inbound -Action Block -Enabled True -Profile Any -Protocol TCP -LocalPort 22 -InterfaceAlias $TransportInterfaceAlias | Out-Null
    # sshd binds a VPN IP: preserve prior dependencies and wait for the tunnel at boot.
    $dependencies = @($state.SshdDependencies) + @('WireGuardTunnel$' + $tunnelName)
    & "$env:WINDIR\System32\sc.exe" config sshd depend= ($dependencies -join '/') *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not set sshd tunnel startup dependency.' }
    Set-Service -Name sshd -StartupType Automatic
    Start-Service -Name sshd
    $publicHostPath = Join-Path $root 'ssh_host_ed25519_key.pub'
    Copy-Item -LiteralPath ($hostKey + '.pub') -Destination $publicHostPath
    Set-PrivateAcl $publicHostPath
    Write-Host 'Worker VPN/SSH setup applied. Agent is installed separately.'
    Write-Host "Copy only the host PUBLIC key back through a trusted path: $publicHostPath"
    Write-Host 'Run check-worker.ps1; unrelated inbound allow rules still require review and independent transport probes.'
} catch {
    Write-Warning 'Setup stopped. State/backup retained under ProgramData\ZT-ServerOps\worker. Run restore-worker.ps1 at the VM console before retrying.'
    throw
}
