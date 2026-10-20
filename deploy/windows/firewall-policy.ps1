# Pure classification of collected filters; importing this file does not change firewall rules.
function Test-WorkerFilterValues([object[]]$Actual, [string[]]$Allowed) {
    if (-not $Actual.Count) { return $false }
    foreach ($value in $Actual) { if ([string]::IsNullOrWhiteSpace("$value") -or "$value" -notin $Allowed) { return $false } }
    return $true
}

function Get-WorkerTransportRuleKind([hashtable]$Filter, [string[]]$TransportInterfaces, [string]$WindowsDirectory) {
    foreach ($name in @('Protocol', 'LocalPort', 'RemotePort', 'IcmpType', 'DynamicTarget', 'LocalAddress', 'RemoteAddress', 'InterfaceAlias', 'InterfaceType', 'Program', 'Package', 'Service', 'EdgeTraversalPolicy')) {
        if (-not $Filter.ContainsKey($name) -or -not @($Filter[$name]).Count -or @($Filter[$name] | Where-Object { [string]::IsNullOrWhiteSpace("$_") }).Count) { return 'Review' }
    }
    $applies = $false
    foreach ($interface in @($Filter.InterfaceAlias)) {
        if ($interface -eq 'Any') { $applies = $true }
        foreach ($transport in $TransportInterfaces) { if ($transport -like $interface) { $applies = $true } }
    }
    if (-not $applies) { return 'OtherInterface' }
    if (-not (Test-WorkerFilterValues $Filter.InterfaceAlias (@('Any') + $TransportInterfaces)) -or
        -not (Test-WorkerFilterValues $Filter.InterfaceType @('Any', 'Lan', 'Wireless', 'RemoteAccess')) -or
        "$($Filter.Package)" -ne 'Any' -or "$($Filter.DynamicTarget)" -ne 'Any' -or "$($Filter.LocalAddress)" -ne 'Any') { return 'Review' }

    $svchost = $WindowsDirectory.TrimEnd('\') + '\System32\svchost.exe'
    $dhcpProgram = "$($Filter.Program)" -in @($svchost, '%SystemRoot%\System32\svchost.exe', '%windir%\System32\svchost.exe')
    if ("$($Filter.Protocol)" -in @('UDP', '17') -and $dhcpProgram -and "$($Filter.Service)" -eq 'Dhcp' -and
        "$($Filter.EdgeTraversalPolicy)" -eq 'Block' -and "$($Filter.IcmpType)" -eq 'Any' -and
        (Test-WorkerFilterValues $Filter.RemoteAddress @('Any', 'LocalSubnet', 'DHCP'))) {
        if ("$($Filter.LocalPort)" -eq '68' -and "$($Filter.RemotePort)" -eq '67') { return 'DHCPv4 client' }
        if ("$($Filter.LocalPort)" -eq '546' -and "$($Filter.RemotePort)" -eq '547') { return 'DHCPv6 client' }
    }
    # NetSecurity reports the unused ICMP local-port field as RPC on Server 2022.
    if ("$($Filter.Program)" -ne 'System' -or "$($Filter.Service)" -ne 'Any' -or
        "$($Filter.LocalPort)" -notin @('Any', 'RPC') -or "$($Filter.RemotePort)" -ne 'Any') { return 'Review' }
    if ("$($Filter.Protocol)" -in @('ICMPv4', '1') -and "$($Filter.IcmpType)" -eq '3:4' -and
        "$($Filter.RemoteAddress)" -eq 'Any' -and "$($Filter.EdgeTraversalPolicy)" -eq 'Block') { return 'IPv4 path MTU error' }
    if ("$($Filter.Protocol)" -in @('ICMPv6', '58')) {
        if ((Test-WorkerFilterValues $Filter.IcmpType @('1', '1:*', '2', '2:*', '3', '3:*', '4', '4:*')) -and
            "$($Filter.RemoteAddress)" -eq 'Any' -and "$($Filter.EdgeTraversalPolicy)" -in @('Block', 'Allow')) { return 'IPv6 control error' }
        # NS/NA need global on-link and unspecified DAD sources; the IPv6 stack validates hop limit 255.
        if ((Test-WorkerFilterValues $Filter.IcmpType @('135', '135:*', '136', '136:*')) -and
            (Test-WorkerFilterValues $Filter.RemoteAddress @('Any', 'LocalSubnet', 'LocalSubnet6', 'fe80::/64', 'fe80::/10')) -and
            "$($Filter.EdgeTraversalPolicy)" -eq 'Block') { return 'IPv6 neighbor discovery' }
        if ((Test-WorkerFilterValues $Filter.IcmpType @('130', '130:*', '131', '131:*', '132', '132:*', '133', '133:*', '134', '134:*', '135', '135:*', '136', '136:*', '143', '143:*')) -and
            (Test-WorkerFilterValues $Filter.RemoteAddress @('LocalSubnet', 'LocalSubnet6', 'fe80::/64', 'fe80::/10')) -and
            "$($Filter.EdgeTraversalPolicy)" -eq 'Block') { return 'IPv6 local-link control' }
    }
    return 'Review'
}
