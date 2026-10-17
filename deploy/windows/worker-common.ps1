# Shared guards for elevated worker setup/restore/check. No changes on import.
function Assert-NoReparsePoint([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'Refusing a reparse point in a worker configuration path.'
        }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-TrustedManagedPath([string]$Path) {
    Assert-NoReparsePoint $Path
    if (Test-Path -LiteralPath $Path) {
        $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18', 'S-1-5-32-544')) {
            throw 'Existing managed paths must be owned by SYSTEM or Administrators; review at the VM console.'
        }
    }
}

function Assert-FirewallProfiles([string[]]$Interfaces) {
    foreach ($profile in @(Get-NetFirewallProfile -PolicyStore ActiveStore)) {
        # Enabled is GpoBoolean/uint16, not System.Boolean; do not use -not.
        if ($profile.Enabled.ToString() -ne 'True' -or $profile.DefaultInboundAction.ToString() -ne 'Block') {
            throw 'Every firewall profile must already be enabled with DefaultInboundAction Block.'
        }
        foreach ($excluded in @($profile.DisabledInterfaceAliases)) {
            foreach ($interface in $Interfaces) {
                if ($interface -like $excluded) { throw 'A chosen NIC is excluded from Windows Firewall; review the profile policy.' }
            }
        }
    }
}

function Assert-WorkerState($State, [string]$Root) {
    $expectedConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
    $expectedBackup = Join-Path $Root 'sshd_config.before-zt'
    if ([IO.Path]::GetFullPath($State.ConfigPath) -ne [IO.Path]::GetFullPath($expectedConfig) -or
        [IO.Path]::GetFullPath($State.BackupPath) -ne [IO.Path]::GetFullPath($expectedBackup) -or
        $State.TunnelName -ne 'zt-worker' -or
        @($State.RuleNames).Count -ne 2 -or
        @($State.RuleNames | Where-Object { $_ -notin @('ZT-ServerOps-SSH-VPN', 'ZT-ServerOps-SSH-Transport-Block') }).Count -or
        $State.SshdStartMode -notin @('Auto', 'Manual', 'Disabled')) {
        throw 'Worker state differs from fixed managed paths/names; no restore/check actions taken.'
    }
}
