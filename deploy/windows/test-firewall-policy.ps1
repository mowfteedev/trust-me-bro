#Requires -Version 5.1
# Synthetic filter regression tests; no elevation, NetSecurity module, or firewall changes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'firewall-policy.ps1')
$script:cases = 0
function Assert-RuleKind([hashtable]$Filter, [string]$Expected, [string]$Case) {
    $actual = Get-WorkerTransportRuleKind $Filter @('Ethernet') 'C:\Windows'
    if ($actual -ne $Expected) { throw "$Case expected '$Expected', received '$actual'." }
    $script:cases++
}

$dhcp = @{
    Name = 'CoreNet-DHCP-In'; Protocol = 'UDP'; LocalPort = @('68'); RemotePort = @('67'); IcmpType = @('Any'); DynamicTarget = 'Any'
    LocalAddress = @('Any'); RemoteAddress = @('Any'); InterfaceAlias = @('Any'); InterfaceType = @('Any')
    Program = 'C:\Windows\System32\svchost.exe'; Package = 'Any'; Service = 'Dhcp'; EdgeTraversalPolicy = 'Block'
}
Assert-RuleKind $dhcp 'DHCPv4 client' 'DHCP client reply'
$case = $dhcp.Clone(); $case.Protocol = '17'; $case.LocalPort = @('546'); $case.RemotePort = @('547')
Assert-RuleKind $case 'DHCPv6 client' 'DHCPv6 numeric protocol'
$case = $dhcp.Clone(); $case.Name = 'Custom narrow DHCP'; $case.InterfaceAlias = @('Ethernet')
Assert-RuleKind $case 'DHCPv4 client' 'Filters determine classification independently of rule name'

$icmp = $dhcp.Clone()
$icmp.Protocol = 'ICMPv6'; $icmp.LocalPort = @('Any'); $icmp.RemotePort = @('Any')
$icmp.IcmpType = @('135:*'); $icmp.Program = 'System'; $icmp.Service = 'Any'; $icmp.RemoteAddress = @('LocalSubnet')
Assert-RuleKind $icmp 'IPv6 neighbor discovery' 'Neighbor discovery local subnet'
$case = $icmp.Clone(); $case.IcmpType = @('135'); $case.LocalPort = @('RPC'); $case.RemoteAddress = @('Any')
Assert-RuleKind $case 'IPv6 neighbor discovery' 'Native neighbor discovery preserves unspecified DAD sources'
$case = $icmp.Clone(); $case.IcmpType = @('134:*'); $case.RemoteAddress = @('fe80::/64')
Assert-RuleKind $case 'IPv6 local-link control' 'Router advertisement link-local'
$case = $icmp.Clone(); $case.IcmpType = @('2:*'); $case.RemoteAddress = @('Any'); $case.EdgeTraversalPolicy = 'Allow'
Assert-RuleKind $case 'IPv6 control error' 'Packet-too-big control error'
$case = $icmp.Clone(); $case.Protocol = 'ICMPv4'; $case.IcmpType = @('3:4'); $case.RemoteAddress = @('Any')
Assert-RuleKind $case 'IPv4 path MTU error' 'IPv4 fragmentation-needed code only'
$case = $icmp.Clone(); $case.LocalPort = @('RPC'); $case.RemoteAddress = @('LocalSubnet6')
Assert-RuleKind $case 'IPv6 neighbor discovery' 'Native ICMP unused-port representation'

foreach ($change in @(
    @{ Protocol = 'TCP'; LocalPort = @('22') },
    @{ LocalPort = @('68', '3389') },
    @{ RemotePort = @('Any') },
    @{ Program = 'Any' },
    @{ Program = 'C:\Temp\svchost.exe' },
    @{ Service = 'Any' },
    @{ Package = 'S-1-15-2-123' },
    @{ DynamicTarget = 'ProximitySharing' },
    @{ InterfaceAlias = @('Eth*') },
    @{ EdgeTraversalPolicy = 'Allow' }
)) {
    $case = $dhcp.Clone()
    foreach ($key in $change.Keys) { $case[$key] = $change[$key] }
    Assert-RuleKind $case 'Review' ('DHCP name cannot mask changed ' + ($change.Keys -join ','))
}
foreach ($change in @(
    @{ IcmpType = @('134'); RemoteAddress = @('Any') },
    @{ IcmpType = @('135:*', '128:*') },
    @{ IcmpType = @('Any') },
    @{ Program = 'Any' },
    @{ Service = 'RemoteAccess' },
    @{ Protocol = '41' },
    @{ Protocol = 'TCP'; LocalPort = @('RPC') },
    @{ EdgeTraversalPolicy = 'Allow' }
)) {
    $case = $icmp.Clone()
    foreach ($key in $change.Keys) { $case[$key] = $change[$key] }
    Assert-RuleKind $case 'Review' ('Local-link rule cannot broaden ' + ($change.Keys -join ','))
}
$case = $dhcp.Clone(); $case.Remove('Program')
Assert-RuleKind $case 'Review' 'Missing filter fails closed'
$case = $dhcp.Clone(); $case.InterfaceAlias = @()
Assert-RuleKind $case 'Review' 'Empty interface filter fails closed'
$case = $dhcp.Clone(); $case.InterfaceAlias = @('Separate isolated NIC')
Assert-RuleKind $case 'OtherInterface' 'Rule does not apply to transport NIC'
Write-Output "$script:cases synthetic firewall policy checks passed; native firewall/Internet isolation remains a separate verification."
