#Requires -Version 5.1
#Requires -RunAsAdministrator
<# Local, read-only evidence. Does not send telemetry/Telegram or prove Internet isolation. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'ZT-ServerOps\worker'
$statePath = Join-Path $root 'setup-state.json'
. (Join-Path $PSScriptRoot 'worker-common.ps1')
foreach ($managed in @((Split-Path -Parent $root), $root, $statePath)) { Assert-TrustedManagedPath $managed }
if (-not (Test-Path -LiteralPath $statePath)) { throw 'Run setup-worker.ps1 first, or inspect a manually configured Worker separately.' }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
Assert-WorkerState $state $root
Assert-TrustedManagedPath $state.ConfigPath
$issues = New-Object System.Collections.Generic.List[string]
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)
if (-not $listeners.Count -or @($listeners | Where-Object { $_.LocalAddress -ne $state.VpnAddress }).Count) { $issues.Add('SSH is missing or listens outside the explicit VPN IPv4 address.') }
foreach ($service in @('sshd', 'WireGuardTunnel$zt-worker', 'ZTServerOpsAgent')) {
    $value = Get-Service -Name $service -ErrorAction SilentlyContinue
    if (-not $value -or $value.Status -ne 'Running') { $issues.Add("Service is not running: $service") }
}
if (@((Get-Service -Name sshd).ServicesDependedOn | Select-Object -ExpandProperty Name) -notcontains 'WireGuardTunnel$zt-worker') { $issues.Add('sshd does not depend on the tunnel; its VPN-only listener may fail after reboot.') }
try { Assert-FirewallProfiles (@($state.TransportInterfaces) + @($state.TunnelName)) }
catch { $issues.Add('A firewall profile is disabled, bypasses a chosen NIC, or does not default to inbound Block.') }
foreach ($name in $state.RuleNames) {
    $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if (-not $rule -or $rule.Enabled -ne 'True') { $issues.Add("Required ZT firewall rule missing/disabled: $name") }
}
$vpnRule = Get-NetFirewallRule -Name 'ZT-ServerOps-SSH-VPN' -ErrorAction SilentlyContinue
if ($vpnRule) {
    $port = $vpnRule | Get-NetFirewallPortFilter
    $addresses = $vpnRule | Get-NetFirewallAddressFilter
    $interfaces = @($vpnRule | Get-NetFirewallInterfaceFilter | Select-Object -ExpandProperty InterfaceAlias)
    if ($vpnRule.Action -ne 'Allow' -or $vpnRule.Direction -ne 'Inbound' -or $vpnRule.Profile.ToString() -ne 'Any' -or
        $port.Protocol -notin @('TCP', '6') -or "$($port.LocalPort)" -ne '22' -or
        ($addresses.LocalAddress -join ',') -ne $state.VpnAddress -or
        ($addresses.RemoteAddress -join ',') -ne $state.GatewayVpnAddress -or
        ($interfaces -join ',') -ne $state.TunnelName) { $issues.Add('VPN SSH firewall rule scope differs from setup.') }
}
$blockRule = Get-NetFirewallRule -Name 'ZT-ServerOps-SSH-Transport-Block' -ErrorAction SilentlyContinue
if ($blockRule) {
    $port = $blockRule | Get-NetFirewallPortFilter
    $addresses = $blockRule | Get-NetFirewallAddressFilter
    $interfaces = @($blockRule | Get-NetFirewallInterfaceFilter | Select-Object -ExpandProperty InterfaceAlias)
    if ($blockRule.Action -ne 'Block' -or $blockRule.Direction -ne 'Inbound' -or
        $port.Protocol -notin @('TCP', '6') -or "$($port.LocalPort)" -ne '22' -or
        ($addresses.LocalAddress -join ',') -ne 'Any' -or ($addresses.RemoteAddress -join ',') -ne 'Any' -or
        $blockRule.Profile.ToString() -ne 'Any' -or
        @(Compare-Object -ReferenceObject @($state.TransportInterfaces) -DifferenceObject $interfaces).Count) { $issues.Add('Transport SSH block rule scope differs from setup.') }
}
$sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
$effective = & $sshd -T -f $state.ConfigPath 2>$null
if ($LASTEXITCODE -ne 0) { $issues.Add('Installed sshd rejects its configuration.') }
else {
    foreach ($required in @('passwordauthentication no', 'pubkeyauthentication yes', 'authenticationmethods publickey', 'allowtcpforwarding no', 'allowagentforwarding no', 'gatewayports no', ('allowusers ' + $state.SshUser + '@' + $state.GatewayVpnAddress))) {
        if ($effective -notcontains $required) { $issues.Add("sshd effective configuration is missing: $required") }
    }
}
$unlisted = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.Name -ne $state.TunnelName -and $_.Name -notin $state.TransportInterfaces })
if ($unlisted.Count) { $issues.Add('New/unlisted active transport NIC detected; scoped SSH blocks do not cover it.') }
$unexpected = New-Object System.Collections.Generic.List[string]
# Conservative inventory: even application-restricted allows are surfaced for review.
# Names/protocol/port/interface are public configuration; no keys/tokens are read.
foreach ($rule in @(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -Action Allow)) {
    if ($rule.Name -in $state.RuleNames) { continue }
    $interfaces = @($rule | Get-NetFirewallInterfaceFilter | Select-Object -ExpandProperty InterfaceAlias)
    $applies = $interfaces -contains 'Any'
    foreach ($interface in $interfaces) {
        foreach ($transport in $state.TransportInterfaces) { if ($transport -like $interface) { $applies = $true } }
    }
    if ($applies) {
        $port = $rule | Get-NetFirewallPortFilter
        $unexpected.Add(('{0}: protocol={1} localPort={2}' -f $rule.Name, $port.Protocol, ($port.LocalPort -join ',')))
    }
}
if ($unexpected.Count) { $issues.Add('Other inbound allow rules apply to transport NICs; transport isolation is incomplete until reviewed/probed.') }
$gatewayReachable = Test-NetConnection -ComputerName $state.GatewayVpnAddress -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $gatewayReachable) { $issues.Add('Gateway TCP/3000 is not reachable over the configured overlay address.') }
$agentService = Get-CimInstance Win32_Service -Filter "Name='ZTServerOpsAgent'"
$agentMemory = $null
if ($agentService -and $agentService.ProcessId) {
    $process = Get-Process -Id $agentService.ProcessId -ErrorAction SilentlyContinue
    if ($process) { $agentMemory = [math]::Round($process.WorkingSet64 / 1MB, 2) }
}
[pscustomobject]@{
    Scope = 'Local Windows inspection only; NOT independent Internet/VPN SSH verification'
    VpnAddress = $state.VpnAddress
    SshListenAddresses = @($listeners | Select-Object -ExpandProperty LocalAddress)
    GatewayTcp3000Reachable = $gatewayReachable
    AgentWorkingSetMiB = $agentMemory
    TransportAllowRulesToReview = $unexpected.ToArray()
    Issues = $issues.ToArray()
    StillRequired = @('Trusted Gateway SSH/PTY + Viewer/logout checks', 'Independent IPv4/IPv6 transport probe and no NAT port forwarding', 'CPU/offline/recovery and reboot tests')
} | ConvertTo-Json -Depth 5
if ($issues.Count) { exit 1 }
