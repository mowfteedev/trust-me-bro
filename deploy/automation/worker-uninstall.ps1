#Requires -Version 5.1
<# Dedicated Windows Worker uninstaller and write-ahead cleanup journal.
   Executes only with elevated local Administrator console.
   No raw token arguments; requires private authorization bundle or saved capability. #>
[CmdletBinding()]
param(
    [ValidateSet('uninstall','cleanup-retry')][string]$Action = 'uninstall',
    [string]$AuthorizationPath,
    [string]$CaFile,
    [switch]$ExportFunctionsOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
$statePath = Join-Path $managedRoot 'state.json'
$workerRoot = Join-Path $env:ProgramData 'ZT-ServerOps\worker'
$workerStatePath = Join-Path $workerRoot 'setup-state.json'
$agentRoot = Join-Path $env:ProgramData 'ZT-ServerOps\agent'
$sshConfigPath = Join-Path $env:ProgramData 'ssh\sshd_config'
$wg = Join-Path $env:ProgramFiles 'WireGuard\wg.exe'
$wireguard = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
$sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
$agentServiceName = 'ZTServerOpsAgent'

if (Test-Path -LiteralPath (Join-Path $repo 'deploy\windows\worker-common.ps1')) {
    . (Join-Path $repo 'deploy\windows\worker-common.ps1')
}

function Stop-Worker([string]$Message) { throw [InvalidOperationException]::new('ZT: ' + $Message) }

function Hash-Text([string]$Text) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
}

function Assert-LocalConsole {
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
        Stop-Worker 'A 64-bit Windows Worker and 64-bit PowerShell process are required.'
    }
    $isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Stop-Worker 'Operation requires an elevated Administrator console.'
    }
    if ($env:SSH_CONNECTION -or $env:SSH_CLIENT -or $env:SSH_TTY) {
        Stop-Worker 'Do not change Worker SSH/network configuration through an SSH connection.'
    }
    if ($host.Name -match 'ServerRemoteHost' -or (Get-Variable -Name PSSenderInfo -ValueOnly -ErrorAction SilentlyContinue)) {
        Stop-Worker 'Do not change Worker configuration through a remote PowerShell session.'
    }
}

function ConvertTo-CanonicalJson($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' } else { return 'false' }
    }
    if ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or $Value -is [uint16] -or $Value -is [uint32] -or $Value -is [uint64]) {
        return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [double] -or $Value -is [float] -or $Value -is [decimal]) {
        return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [string]) {
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append([char]34)
        for ($i = 0; $i -lt $Value.Length; $i++) {
            $c = $Value[$i]
            if ($c -eq '"') {
                [void]$sb.Append([char]92).Append([char]34)
            } elseif ($c -eq '\') {
                [void]$sb.Append([char]92).Append([char]92)
            } elseif ([int]$c -eq 8) {
                [void]$sb.Append([char]92).Append('b')
            } elseif ([int]$c -eq 12) {
                [void]$sb.Append([char]92).Append('f')
            } elseif ([int]$c -eq 10) {
                [void]$sb.Append([char]92).Append('n')
            } elseif ([int]$c -eq 13) {
                [void]$sb.Append([char]92).Append('r')
            } elseif ([int]$c -eq 9) {
                [void]$sb.Append([char]92).Append('t')
            } elseif ([int]$c -lt 32) {
                [void]$sb.AppendFormat('\u{0:x4}', [int]$c)
            } else {
                [void]$sb.Append($c)
            }
        }
        [void]$sb.Append([char]34)
        return $sb.ToString()
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = New-Object Collections.Generic.List[string]
        foreach ($k in $Value.Keys) { $keys.Add([string]$k) }
        $keys.Sort([StringComparer]::Ordinal)
        $items = New-Object Collections.Generic.List[string]
        foreach ($k in $keys) {
            $kJson = ConvertTo-CanonicalJson $k
            $vJson = ConvertTo-CanonicalJson $Value[$k]
            $items.Add($kJson + ':' + $vJson)
        }
        return '{' + ($items -join ',') + '}'
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $names = New-Object Collections.Generic.List[string]
        foreach ($p in $Value.PSObject.Properties) { $names.Add($p.Name) }
        $names.Sort([StringComparer]::Ordinal)
        $items = New-Object Collections.Generic.List[string]
        foreach ($n in $names) {
            $kJson = ConvertTo-CanonicalJson $n
            $vJson = ConvertTo-CanonicalJson $Value.$n
            $items.Add($kJson + ':' + $vJson)
        }
        return '{' + ($items -join ',') + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = New-Object Collections.Generic.List[string]
        foreach ($elem in $Value) {
            $items.Add((ConvertTo-CanonicalJson $elem))
        }
        return '[' + ($items -join ',') + ']'
    }
    return ConvertTo-CanonicalJson ($Value.ToString())
}

function Get-AllowedManagedPaths {
    $base = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }
    return @(
        (Join-Path $base 'ssh\sshd_config'),
        (Join-Path $base 'ZT-ServerOps\worker\sshd_config.before-zt'),
        (Join-Path $base 'ZT-ServerOps\worker\setup-state.json'),
        (Join-Path $base 'ZT-ServerOps\worker\zt-worker.conf'),
        (Join-Path $base 'ZT-ServerOps\worker\authorized_keys'),
        (Join-Path $base 'ZT-ServerOps\worker\ssh_host_ed25519_key.pub'),
        (Join-Path $base 'ZT-ServerOps\agent\zt-agent.exe'),
        (Join-Path $base 'ZT-ServerOps\agent\config.json')
    )
}

function Validate-BackupFile([string]$PathStr, [string]$BeforeHash, [string]$RecordedBackup) {
    if (-not $RecordedBackup -or -not (Test-Path -LiteralPath $RecordedBackup -PathType Leaf)) {
        Stop-Worker "Backup file for $PathStr is missing."
    }
    if (Get-Command 'Assert-NoReparsePoint' -ErrorAction SilentlyContinue) {
        Assert-NoReparsePoint $RecordedBackup
    }
    $hash = (Get-FileHash -LiteralPath $RecordedBackup -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ine $BeforeHash) {
        Stop-Worker "Backup file for $PathStr checksum mismatch."
    }
    return $RecordedBackup
}

function Get-LocalWorkerWgPublicKey($StateData, [string]$RootPath) {
    if ($StateData -and $StateData.worker_wireguard_public_key) {
        return $StateData.worker_wireguard_public_key
    }
    $privateFile = Join-Path $RootPath 'wireguard.private'
    if ((Test-Path -LiteralPath $privateFile) -and (Test-Path -LiteralPath $wg)) {
        try {
            $priv = (Get-Content -LiteralPath $privateFile -Raw).Trim()
            $pub = ($priv | & $wg pubkey 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $pub.Length -eq 44) { return $pub }
        } catch {}
    }
    $cleanupFile = Join-Path $RootPath 'cleanup.json'
    if (Test-Path -LiteralPath $cleanupFile) {
        try {
            $cdata = Get-Content -LiteralPath $cleanupFile -Raw | ConvertFrom-Json
            if ($cdata -and $cdata.wireguard_public_key) { return $cdata.wireguard_public_key }
        } catch {}
    }
    Stop-Worker 'Cannot determine local Worker WireGuard public key; manual review required.'
}

function Check-OffboardingBundle($Bundle, $Assignment, [string]$LocalWorkerWgPubKey) {
    $expected = @('cleanup_token','completion_url','gateway_id','invitation_id','node_id','node_ip','node_name','operation_id','version','wireguard_public_key')
    $actual = @($Bundle.PSObject.Properties.Name | Sort-Object)
    if (@(Compare-Object $actual ($expected | Sort-Object)).Count -gt 0) {
        Stop-Worker 'Authorization bundle must contain exactly the required keys.'
    }
    if ($Bundle.version -is [bool] -or $Bundle.version -ne 1) {
        Stop-Worker 'Unsupported authorization bundle version.'
    }
    foreach ($name in $expected | Where-Object { $_ -ne 'version' }) {
        if ($Bundle.$name -isnot [string]) {
            Stop-Worker 'Authorization bundle fields must be strings.'
        }
    }

    foreach ($key in @('operation_id', 'node_id', 'invitation_id')) {
        $val = $Bundle.$key
        $guid = [Guid]::Empty
        if (-not [Guid]::TryParse($val, [ref]$guid)) {
            Stop-Worker "Authorization bundle $key is invalid."
        }
        if ($guid.ToString('D').ToLowerInvariant() -cne $val) {
            Stop-Worker "Authorization bundle $key is invalid."
        }
    }

    try {
        $pubBytes = [Convert]::FromBase64String($Bundle.wireguard_public_key)
    } catch {
        Stop-Worker 'Authorization bundle wireguard_public_key is invalid.'
    }
    if ($pubBytes.Length -ne 32 -or [Convert]::ToBase64String($pubBytes) -cne $Bundle.wireguard_public_key) {
        Stop-Worker 'Authorization bundle wireguard_public_key is invalid.'
    }
    $allZero = $true
    foreach ($b in $pubBytes) { if ($b -ne 0) { $allZero = $false; break } }
    if ($allZero) {
        Stop-Worker 'WireGuard public key cannot be all zeros.'
    }

    $ip = $null
    if (-not [Net.IPAddress]::TryParse($Bundle.node_ip, [ref]$ip) -or
        $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $ip.ToString() -cne $Bundle.node_ip) {
        Stop-Worker 'Authorization bundle node_ip is invalid.'
    }

    if ($Bundle.node_name -notmatch '^[a-zA-Z0-9_-]{3,64}$') {
        Stop-Worker 'Authorization bundle node_name is invalid.'
    }

    if ($Bundle.cleanup_token -notmatch '^[0-9a-f]{64}$') {
        Stop-Worker 'Authorization bundle cleanup_token is invalid.'
    }

    if ($Bundle.gateway_id -cne $Assignment.gateway_id) {
        Stop-Worker 'Authorization bundle gateway_id does not match installed Worker.'
    }
    if ($Bundle.node_id -cne $Assignment.node_id) {
        Stop-Worker 'Authorization bundle node_id does not match installed Worker.'
    }
    if ($Bundle.node_name -cne $Assignment.node_name) {
        Stop-Worker 'Authorization bundle node_name does not match installed Worker.'
    }
    if ($Bundle.invitation_id -cne $Assignment.invitation_id) {
        Stop-Worker 'Authorization bundle invitation_id does not match installed Worker.'
    }
    if ($Bundle.node_ip -cne $Assignment.node_ip) {
        Stop-Worker 'Authorization bundle node_ip does not match installed Worker.'
    }

    if ($LocalWorkerWgPubKey -and $Bundle.wireguard_public_key -cne $LocalWorkerWgPubKey) {
        Stop-Worker 'Authorization bundle wireguard_public_key does not match local Worker identity.'
    }

    $regUri = $null
    if (-not [Uri]::TryCreate($Assignment.registration_url, [UriKind]::Absolute, [ref]$regUri) -or
        $regUri.Scheme -ne 'https' -or $regUri.UserInfo -or $regUri.Query -or $regUri.Fragment) {
        Stop-Worker 'Installed Worker registration_url is invalid.'
    }
    $trustedOrigin = "$($regUri.Scheme)://$($regUri.Authority)"
    $expectedCompletion = "$trustedOrigin/api/offboarding/complete"

    $compUri = $null
    if (-not [Uri]::TryCreate($Bundle.completion_url, [UriKind]::Absolute, [ref]$compUri) -or
        $compUri.Scheme -ne 'https' -or $compUri.UserInfo -or $compUri.Query -or $compUri.Fragment -or
        $Bundle.completion_url -cne $expectedCompletion) {
        Stop-Worker 'completion_url must match trusted Gateway HTTPS offboarding endpoint.'
    }

    return [ordered]@{
        bundle = $Bundle
        trusted_origin = $trustedOrigin
        expected_completion = $expectedCompletion
    }
}

function Read-PrivateAuthBundle([string]$Path) {
    if (-not $Path) { Stop-Worker 'AuthorizationPath is required.' }
    if (Get-Command 'Assert-NoReparsePoint' -ErrorAction SilentlyContinue) {
        Assert-NoReparsePoint $Path
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-Worker 'Authorization bundle does not exist or is not a regular file.'
    }
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -gt 65536) {
        Stop-Worker 'Authorization bundle exceeds 64KiB.'
    }
    $current = $null
    try {
        $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    } catch {
        # Non-Windows test harness or restricted environment
    }
    $allowed = @('S-1-5-18', 'S-1-5-32-544')
    if ($current) { $allowed += $current }
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) {
        Stop-Worker 'Authorization bundle owner is not trusted.'
    }
    foreach ($entry in @($acl.Access)) {
        $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($entry.AccessControlType -eq 'Allow' -and $sid -notin $allowed) {
            Stop-Worker 'Authorization bundle must not be readable by other Windows identities.'
        }
    }
    try {
        $data = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    } catch {
        Stop-Worker 'Authorization bundle contains invalid JSON.'
    }
    if (-not $data) {
        Stop-Worker 'Authorization bundle must contain a JSON object.'
    }
    return $data
}

function New-PinnedCaValidator([string]$Path) {
    if (-not ('ZTWorkerPinnedCa' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
public sealed class ZTWorkerPinnedCa {
    private readonly X509Certificate2 trusted;
    public ZTWorkerPinnedCa(byte[] certificate) { trusted = new X509Certificate2(certificate); }
    public RemoteCertificateValidationCallback Callback { get { return Validate; } }
    private bool Validate(object sender, X509Certificate certificate, X509Chain ignored, SslPolicyErrors errors) {
        if (certificate == null || (errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
        using (X509Certificate2 leaf = new X509Certificate2(certificate))
        using (X509Chain chain = new X509Chain()) {
            chain.ChainPolicy.ExtraStore.Add(trusted);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
            chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));
            if (!chain.Build(leaf) || chain.ChainElements.Count == 0) return false;
            foreach (X509ChainStatus status in chain.ChainStatus) {
                if (status.Status != X509ChainStatusFlags.UntrustedRoot && status.Status != X509ChainStatusFlags.NoError) return false;
            }
            X509Certificate2 root = chain.ChainElements[chain.ChainElements.Count - 1].Certificate;
            return String.Equals(root.Thumbprint, trusted.Thumbprint, StringComparison.OrdinalIgnoreCase);
        }
    }
}
'@
    }
    if (Get-Command 'Assert-NoReparsePoint' -ErrorAction SilentlyContinue) {
        Assert-NoReparsePoint $Path
    }
    $caPath = (Resolve-Path -LiteralPath $Path).Path
    $caText = [IO.File]::ReadAllText($caPath)
    if ($caText -match '(?s)-----BEGIN CERTIFICATE-----\s*(.*?)\s*-----END CERTIFICATE-----') {
        $der = [Convert]::FromBase64String(($Matches[1] -replace '\s', ''))
    } else {
        $der = [IO.File]::ReadAllBytes($caPath)
    }
    return New-Object ZTWorkerPinnedCa -ArgumentList @(,$der)
}

function Invoke-VerifyOffboarding($Bundle, [string]$TrustedOrigin, [string]$CaFilePath) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $url = "$TrustedOrigin/api/offboarding/verify"
    $request = [Net.HttpWebRequest]::Create($url)
    $request.UserAgent = 'ZT-ServerOps/1.0'
    $request.Method = 'POST'
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    $request.Timeout = 15000
    $request.ReadWriteTimeout = 15000
    $request.ContentType = 'application/json'
    $request.Headers.Add('X-Cleanup-Token', $Bundle.cleanup_token)
    if ($CaFilePath) {
        $validator = New-PinnedCaValidator $CaFilePath
        $request.ServerCertificateValidationCallback = $validator.Callback
    }

    $payload = [ordered]@{
        version = 1
        operation_id = $Bundle.operation_id
        gateway_id = $Bundle.gateway_id
        node_id = $Bundle.node_id
        invitation_id = $Bundle.invitation_id
        wireguard_public_key = $Bundle.wireguard_public_key
        node_ip = $Bundle.node_ip
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-CanonicalJson $payload))
    $request.ContentLength = $bytes.Length
    $response = $null
    try {
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) {
            Stop-Worker 'Gateway offboarding verification did not return success.'
        }
        $input = $response.GetResponseStream()
        $output = New-Object IO.MemoryStream
        try {
            $buffer = New-Object byte[] 4096
            while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $output.Write($buffer, 0, $count)
                if ($output.Length -gt 65536) {
                    Stop-Worker 'Gateway verification response exceeds 64KiB.'
                }
            }
            $reply = [Text.Encoding]::UTF8.GetString($output.ToArray()) | ConvertFrom-Json
        } finally {
            $output.Dispose()
            $input.Dispose()
        }

        if (-not $reply -or -not $reply.success) {
            Stop-Worker 'Gateway offboarding verification was unsuccessful.'
        }
        foreach ($key in @('operation_id', 'node_id', 'node_name', 'node_ip', 'invitation_id', 'gateway_id', 'wireguard_public_key')) {
            if ($reply.$key -cne $Bundle.$key) {
                Stop-Worker "Gateway returned mismatched $key during offboarding verification."
            }
        }
        $lifecycle = $reply.lifecycle_state
        if ($lifecycle -eq 'RETIRING') {
            Stop-Worker 'Offboarding is still RETIRING on Gateway; cannot mutate local system until REVOKED or PENDING_LOCAL_CLEANUP.'
        }
        if ($lifecycle -notin @('REVOKED', 'PENDING_LOCAL_CLEANUP')) {
            Stop-Worker "Unexpected Gateway lifecycle state: $lifecycle."
        }
        return $reply
    } catch [Net.WebException] {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        switch ($code) {
            400 { Stop-Worker 'Gateway rejected offboarding verification payload.' }
            401 { Stop-Worker 'Offboarding cleanup token is invalid or expired.' }
            409 { Stop-Worker 'Offboarding identity mismatch on Gateway.' }
            503 { Stop-Worker 'Gateway offboarding service is temporarily unavailable; retry later.' }
            default { Stop-Worker 'Cannot reach Gateway offboarding verification endpoint; identity is preserved for retry.' }
        }
    } finally {
        if ($response) { $response.Dispose() }
    }
}

function Normalize-ManagedState($RawManaged) {
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
    if (-not $RawManaged) { return $dict }

    if ($RawManaged -is [System.Collections.IDictionary]) {
        foreach ($key in $RawManaged.Keys) {
            $dict[[string]$key] = Normalize-ManagedEntry $RawManaged[$key]
        }
    } elseif ($RawManaged -is [System.Management.Automation.PSCustomObject]) {
        foreach ($prop in $RawManaged.PSObject.Properties) {
            $dict[[string]$prop.Name] = Normalize-ManagedEntry $prop.Value
        }
    }
    return $dict
}

function Normalize-ManagedEntry($Entry) {
    $d = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
    if (-not $Entry) { return $d }

    if ($Entry -is [System.Collections.IDictionary]) {
        foreach ($k in $Entry.Keys) {
            $d[[string]$k] = $Entry[$k]
        }
    } elseif ($Entry -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in $Entry.PSObject.Properties) {
            $d[[string]$p.Name] = $p.Value
        }
    }
    return $d
}

function Get-EntryValue($Entry, [string]$Key) {
    if (-not $Entry -or -not $Key) { return $null }
    if ($Entry -is [System.Collections.Generic.Dictionary[string,string]] -or
        $Entry -is [System.Collections.Generic.Dictionary[string,object]] -or
        $Entry -is [System.Collections.Hashtable]) {
        if ($Entry.ContainsKey($Key)) { return $Entry[$Key] }
        return $null
    }
    if ($Entry -is [System.Collections.IDictionary]) {
        if ($Entry.Contains($Key)) { return $Entry[$Key] }
        return $null
    }
    if ($Entry -is [System.Management.Automation.PSCustomObject]) {
        $p = $Entry.PSObject.Properties[$Key]
        if ($null -ne $p) { return $p.Value }
        return $null
    }
    return $null
}

function Set-EntryValue($Target, [string]$Key, $Value) {
    if ($null -eq $Target -or -not $Key) { return }
    if ($Target -is [System.Collections.IDictionary]) {
        $Target[$Key] = $Value
        return
    }
    if ($Target -is [System.Management.Automation.PSCustomObject]) {
        $p = $Target.PSObject.Properties[$Key]
        if ($null -ne $p) {
            $p.Value = $Value
        } else {
            $Target | Add-Member -NotePropertyName $Key -NotePropertyValue $Value -Force
        }
        return
    }
    try {
        $Target.$Key = $Value
    } catch {
        $Target | Add-Member -NotePropertyName $Key -NotePropertyValue $Value -Force
    }
}

function Test-ManagedKey($ManagedDict, [string]$PathStr) {
    if (-not $ManagedDict -or -not $PathStr) { return $false }
    if ($ManagedDict -is [System.Collections.Generic.Dictionary[string,string]] -or
        $ManagedDict -is [System.Collections.Generic.Dictionary[string,object]] -or
        $ManagedDict -is [System.Collections.Hashtable]) {
        return $ManagedDict.ContainsKey($PathStr)
    }
    if ($ManagedDict -is [System.Collections.IDictionary]) {
        return $ManagedDict.Contains($PathStr)
    }
    if ($ManagedDict -is [System.Management.Automation.PSCustomObject]) {
        return ($null -ne $ManagedDict.PSObject.Properties[$PathStr])
    }
    return $false
}

function Get-ManagedEntry($ManagedDict, [string]$PathStr) {
    if (-not $ManagedDict -or -not $PathStr) { return $null }
    if ($ManagedDict -is [System.Collections.Generic.Dictionary[string,string]] -or
        $ManagedDict -is [System.Collections.Generic.Dictionary[string,object]] -or
        $ManagedDict -is [System.Collections.Hashtable]) {
        if ($ManagedDict.ContainsKey($PathStr)) { return $ManagedDict[$PathStr] }
        return $null
    }
    if ($ManagedDict -is [System.Collections.IDictionary]) {
        if ($ManagedDict.Contains($PathStr)) { return $ManagedDict[$PathStr] }
        return $null
    }
    if ($ManagedDict -is [System.Management.Automation.PSCustomObject]) {
        $p = $ManagedDict.PSObject.Properties[$PathStr]
        if ($null -ne $p) { return $p.Value }
        return $null
    }
    return $null
}

function Normalize-StepsDict($Steps) {
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if (-not $Steps) { return $dict }

    if ($Steps -is [System.Collections.Generic.Dictionary[string,string]]) {
        foreach ($k in $Steps.Keys) {
            $dict[$k] = [string]$Steps[$k]
        }
        return $dict
    }

    if ($Steps -is [System.Collections.IDictionary]) {
        foreach ($k in $Steps.Keys) {
            if ($null -ne $k) {
                $dict[[string]$k] = [string]$Steps[$k]
            }
        }
        return $dict
    }

    if ($Steps -is [System.Management.Automation.PSCustomObject]) {
        foreach ($prop in $Steps.PSObject.Properties) {
            if ($null -ne $prop -and $prop.Name) {
                $dict[[string]$prop.Name] = [string]$prop.Value
            }
        }
        return $dict
    }

    return $dict
}

function Get-StepOutcome($Steps, [string]$StepName) {
    if (-not $Steps -or -not $StepName) { return $null }

    if ($Steps -is [System.Collections.Generic.Dictionary[string,string]]) {
        if ($Steps.ContainsKey($StepName)) { return [string]$Steps[$StepName] }
        return $null
    }

    if ($Steps -is [System.Collections.Generic.Dictionary[string,object]]) {
        if ($Steps.ContainsKey($StepName)) { return [string]$Steps[$StepName] }
        return $null
    }

    if ($Steps -is [System.Collections.IDictionary]) {
        if ($Steps.Contains($StepName)) { return [string]$Steps[$StepName] }
        return $null
    }

    if ($Steps -is [System.Management.Automation.PSCustomObject]) {
        $prop = $Steps.PSObject.Properties[$StepName]
        if ($null -ne $prop) { return [string]$prop.Value }
        return $null
    }

    return $null
}

function Get-ManagedKeys($ManagedDict) {
    $keys = New-Object Collections.Generic.List[string]
    if (-not $ManagedDict) { return @() }
    if ($ManagedDict -is [System.Collections.IDictionary]) {
        foreach ($k in $ManagedDict.Keys) { $keys.Add([string]$k) }
    } elseif ($ManagedDict -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in $ManagedDict.PSObject.Properties) { $keys.Add([string]$p.Name) }
    }
    return $keys.ToArray()
}

function Check-AgentServiceOwnership($Preflight) {
    if (-not (Get-Command Get-Service -ErrorAction SilentlyContinue)) { return $true }
    $state = if ($Preflight -and (Get-EntryValue $Preflight 'state')) { Get-EntryValue $Preflight 'state' } else { $Preflight }
    if (-not $state) { return $false }

    $ownedServices = Get-EntryValue $state 'owned_services'
    $ownedAgent = if ($ownedServices) { Get-EntryValue $ownedServices 'agent' } else { $null }

    $expectedCmd = if ($ownedAgent) { Get-EntryValue $ownedAgent 'command' } else { $null }
    $targetSvcName = if ($ownedAgent) { Get-EntryValue $ownedAgent 'name' } else { $agentServiceName }
    if (-not $targetSvcName) { $targetSvcName = $agentServiceName }

    $svc = Get-Service -Name $targetSvcName -ErrorAction SilentlyContinue
    if (-not $svc) { return $true }
    if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) { return $true }
    $svcCim = Get-CimInstance Win32_Service -Filter "Name='$targetSvcName'" -ErrorAction SilentlyContinue
    if (-not $svcCim) { return $true }

    if (-not $expectedCmd) {
        $base = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }
        $agentBin = Join-Path $base 'ZT-ServerOps\agent\zt-agent.exe'
        $agentConfig = Join-Path $base 'ZT-ServerOps\agent\config.json'
        $expectedCmd = '"' + $agentBin + '" --service --config "' + $agentConfig + '"'
    }

    $actualCmd = $svcCim.PathName
    if (-not $actualCmd) { return $false }
    if ($actualCmd.Trim().ToLowerInvariant() -ne $expectedCmd.Trim().ToLowerInvariant()) {
        return $false
    }
    return $true
}

function Preflight-Uninstall($StateData) {
    if (-not $StateData -or $StateData.version -ne 1 -or $StateData.kind -ne 'zt-worker-automation') {
        Stop-Worker 'Legacy or missing Worker state; no valid automation installation found for uninstall.'
    }
    $assignment = Get-EntryValue $StateData 'assignment'
    if (-not $assignment) {
        Stop-Worker 'Worker state lacks assignment record; manual review required.'
    }

    $allowed = Get-AllowedManagedPaths
    $conflicts = New-Object 'System.Collections.Generic.Dictionary[string,string]'

    $managed = Normalize-ManagedState (Get-EntryValue $StateData 'managed')
    $agentSha256 = Get-EntryValue $StateData 'agent_sha256'
    $configuredHash = Get-EntryValue $StateData 'configured_hash'

    # Preflight all managed files recorded in journal
    foreach ($path in (Get-ManagedKeys $managed)) {
        if (-not (Test-Path -LiteralPath $path)) {
            continue
        }
        $info = Get-ManagedEntry $managed $path
        $currHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        $beforeHash = Get-EntryValue $info 'before_hash'
        $afterHash = Get-EntryValue $info 'after_hash'
        $expectedHash = Get-EntryValue $info 'expected_hash'
        $backupPath = Get-EntryValue $info 'backup'

        if ($null -eq $beforeHash) {
            # File newly created by installer: must have trusted fingerprint
            $fingerprint = if ($afterHash) { $afterHash.ToLowerInvariant() } elseif ($expectedHash) { $expectedHash.ToLowerInvariant() } else { $null }
            if (-not $fingerprint -and $path -like '*zt-agent.exe*' -and $agentSha256) {
                $fingerprint = $agentSha256.ToLowerInvariant()
            }
            if (-not $fingerprint) {
                $conflicts[$path] = 'Missing trusted fingerprint in journal; cannot verify ownership/integrity to delete.'
            } elseif ($currHash -ine $fingerprint) {
                $conflicts[$path] = 'File was modified since installation; preserving user edits.'
            }
        } else {
            # File pre-existed before installer
            $expectedAfter = if ($afterHash) { $afterHash.ToLowerInvariant() } elseif ($configuredHash -and $path -like '*sshd_config*') { $configuredHash.ToLowerInvariant() } else { $null }
            if ($expectedAfter -and $currHash -ine $expectedAfter) {
                $conflicts[$path] = 'File was modified since installation; preserving user edits.'
            }
            if (-not $backupPath -or -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
                $conflicts[$path] = 'Backup file is missing; cannot safely restore.'
            } else {
                try {
                    [void](Validate-BackupFile $path $beforeHash $backupPath)
                } catch {
                    $conflicts[$path] = $_.Exception.Message
                }
            }
        }
    }

    # Preflight SSH config & backup
    $baseData = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }
    $resolvedSshConfig = if ($sshConfigPath) { $sshConfigPath } else { Join-Path $baseData 'ssh\sshd_config' }
    $resolvedWorkerState = if ($workerStatePath) { $workerStatePath } else { Join-Path $baseData 'ZT-ServerOps\worker\setup-state.json' }
    $resolvedWorkerRoot = if ($workerRoot) { $workerRoot } else { Join-Path $baseData 'ZT-ServerOps\worker' }
    $resolvedAgentRoot = if ($agentRoot) { $agentRoot } else { Join-Path $baseData 'ZT-ServerOps\agent' }

    if ($resolvedSshConfig -and (Test-Path -LiteralPath $resolvedSshConfig)) {
        $currHash = (Get-FileHash -LiteralPath $resolvedSshConfig -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($configuredHash -and $currHash -ine $configuredHash) {
            $conflicts[$resolvedSshConfig] = 'File was modified since installation; preserving user edits.'
        }
    }
    if ($resolvedWorkerState -and (Test-Path -LiteralPath $resolvedWorkerState)) {
        $setupState = Get-Content -LiteralPath $resolvedWorkerState -Raw | ConvertFrom-Json
        if (Get-Command 'Assert-WorkerState' -ErrorAction SilentlyContinue) {
            Assert-WorkerState $setupState $resolvedWorkerRoot
        }
        $hadConfig = Get-EntryValue $setupState 'HadConfig'
        $backupPath = Get-EntryValue $setupState 'BackupPath'
        if ($hadConfig) {
            if (-not $backupPath -or -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
                $conflicts[$resolvedSshConfig] = 'Backup file is missing; cannot safely restore.'
            } else {
                try {
                    [void](Validate-BackupFile $resolvedSshConfig (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant() $backupPath)
                } catch {
                    $conflicts[$resolvedSshConfig] = $_.Exception.Message
                }
            }
        }
        # Check SSH service status negative and positive:
        # Distinguish before-state (to restore to) from installer after-state (to identify external modifications)
        $sshdSvc = Get-Service -Name sshd -ErrorAction SilentlyContinue
        if ($sshdSvc) {
            $sshdCim = Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue

            $expectedInstalledRunning = if ($null -ne (Get-EntryValue $setupState 'SshdInstalledRunning')) { [bool](Get-EntryValue $setupState 'SshdInstalledRunning') } else { $true }
            $expectedInstalledStartMode = if (Get-EntryValue $setupState 'SshdInstalledStartMode') { [string](Get-EntryValue $setupState 'SshdInstalledStartMode') } else { 'Auto' }

            if ($expectedInstalledRunning -and $sshdSvc.Status -ne 'Running') {
                $conflicts['sshd'] = 'sshd service was expected to be running after installation but is currently stopped.'
            } elseif (-not $expectedInstalledRunning -and $sshdSvc.Status -eq 'Running') {
                $conflicts['sshd'] = 'sshd service was expected to be stopped after installation but is currently running.'
            }

            if ($sshdCim -and $expectedInstalledStartMode) {
                if ($sshdCim.StartMode -ne $expectedInstalledStartMode) {
                    $conflicts['sshd_startmode'] = "sshd startmode changed from $expectedInstalledStartMode to $($sshdCim.StartMode)."
                }
            }
        }
    }

    # Preflight Agent binary & service identity
    $agentBin = Join-Path $resolvedAgentRoot 'zt-agent.exe'
    if (Test-Path -LiteralPath $agentBin) {
        if ($agentSha256) {
            $currBinHash = (Get-FileHash -LiteralPath $agentBin -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($currBinHash -ine $agentSha256) {
                $conflicts[$agentBin] = 'Agent binary was modified since installation; preserving user edits.'
            }
        }
    }
    if (-not (Check-AgentServiceOwnership $StateData)) {
        $conflicts[$agentServiceName] = 'Service binary path does not match expected agent installation; preserving foreign service.'
    }

    return [ordered]@{
        conflicts = $conflicts
        state = $StateData
        worker_state_path = $workerStatePath
        assignment = $assignment
        managed = $managed
    }
}

function Restore-OrRemoveManagedFile([string]$PathStr, $Preflight) {
    $conflicts = $Preflight.conflicts
    if ($conflicts.ContainsKey($PathStr)) {
        return $false
    }
    $managed = $Preflight.managed
    if (-not $managed -or -not (Test-ManagedKey $managed $PathStr)) {
        # Unowned file: NOT in managed journal. MUST NOT DELETE!
        if (Test-Path -LiteralPath $PathStr) {
            $conflicts[$PathStr] = 'File is not recorded in managed state journal; preserving unowned file.'
            return $false
        }
        return $true
    }

    if (-not (Test-Path -LiteralPath $PathStr)) {
        return $true
    }

    $info = Get-ManagedEntry $managed $PathStr
    $currHash = (Get-FileHash -LiteralPath $PathStr -Algorithm SHA256).Hash.ToLowerInvariant()
    $beforeHash = Get-EntryValue $info 'before_hash'
    $afterHash = Get-EntryValue $info 'after_hash'
    $expectedHash = Get-EntryValue $info 'expected_hash'
    $backupPath = Get-EntryValue $info 'backup'

    if ($null -eq $beforeHash) {
        # Newly created file by installer: verify fingerprint before removing
        $fingerprint = if ($afterHash) { $afterHash.ToLowerInvariant() } elseif ($expectedHash) { $expectedHash.ToLowerInvariant() } else { $null }
        $stateObj = Get-EntryValue $Preflight 'state'
        $agentSha = if ($stateObj) { Get-EntryValue $stateObj 'agent_sha256' } else { $null }
        if (-not $fingerprint -and $agentSha -and $PathStr -like '*zt-agent.exe*') {
            $fingerprint = $agentSha.ToLowerInvariant()
        }
        if (-not $fingerprint) {
            $conflicts[$PathStr] = 'Missing trusted fingerprint in journal; cannot verify ownership/integrity to delete.'
            return $false
        }
        if ($currHash -ine $fingerprint) {
            $conflicts[$PathStr] = 'File was modified since installation; preserving user edits.'
            return $false
        }
        if (Get-Command 'Assert-NoReparsePoint' -ErrorAction SilentlyContinue) {
            Assert-NoReparsePoint $PathStr
        }
        Remove-Item -LiteralPath $PathStr -Force -ErrorAction SilentlyContinue
        return (-not (Test-Path -LiteralPath $PathStr))
    } else {
        # Pre-existing file: verify and restore from backup
        if ($afterHash -and $currHash -ine $afterHash.ToLowerInvariant()) {
            $conflicts[$PathStr] = 'File was modified since installation; preserving user edits.'
            return $false
        }
        if (-not $backupPath -or -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            $conflicts[$PathStr] = 'Backup file is missing; cannot safely restore.'
            return $false
        }
        try {
            $backupFile = Validate-BackupFile $PathStr $beforeHash $backupPath
            if (Get-Command 'Assert-NoReparsePoint' -ErrorAction SilentlyContinue) {
                Assert-NoReparsePoint $PathStr
            }
            Copy-Item -LiteralPath $backupFile -Destination $PathStr -Force
            return $true
        } catch {
            $conflicts[$PathStr] = 'Failed to restore pre-existing file from backup.'
            return $false
        }
    }
}

function Cleanup-AgentStep($Preflight) {
    $conflicts = $Preflight.conflicts
    $agentBin = Join-Path $agentRoot 'zt-agent.exe'
    $agentConfig = Join-Path $agentRoot 'config.json'
    $hasConflict = $conflicts.ContainsKey($agentBin) -or $conflicts.ContainsKey($agentServiceName)
    try {
        $state = if ($Preflight -and $Preflight.state) { $Preflight.state } else { $Preflight }
        $ownedServices = Get-EntryValue $state 'owned_services'
        $ownedAgent = if ($ownedServices) { Get-EntryValue $ownedServices 'agent' } else { $null }
        $targetServiceName = if ($ownedAgent) { Get-EntryValue $ownedAgent 'name' } else { $agentServiceName }
        if (-not $targetServiceName) { $targetServiceName = $agentServiceName }

        if (-not (Check-AgentServiceOwnership $Preflight)) {
            $hasConflict = $true
        } else {
            $svc = Get-Service -Name $targetServiceName -ErrorAction SilentlyContinue
            if ($svc) {
                if ($svc.Status -ne 'Stopped') {
                    Stop-Service -Name $targetServiceName -Force -ErrorAction SilentlyContinue
                    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
                }
                if (-not $conflicts.ContainsKey($targetServiceName)) {
                    & "$env:WINDIR\System32\sc.exe" delete $targetServiceName *> $null
                }
            }
        }

        $okBin = Restore-OrRemoveManagedFile $agentBin $Preflight
        $okConfig = Restore-OrRemoveManagedFile $agentConfig $Preflight

        $logsDir = Join-Path $agentRoot 'logs'
        $knownLog = Join-Path $logsDir 'agent.log'
        if (Test-Path -LiteralPath $knownLog) {
            Remove-Item -LiteralPath $knownLog -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $logsDir) {
            $remainingLogs = @(Get-ChildItem -LiteralPath $logsDir -Force -ErrorAction SilentlyContinue)
            if ($remainingLogs.Count -eq 0) {
                Remove-Item -LiteralPath $logsDir -Force -ErrorAction SilentlyContinue
            }
        }
        if (Test-Path -LiteralPath $agentRoot) {
            $remaining = @(Get-ChildItem -LiteralPath $agentRoot -Force -ErrorAction SilentlyContinue)
            if ($remaining.Count -eq 0) {
                Remove-Item -LiteralPath $agentRoot -Force -ErrorAction SilentlyContinue
            }
        }

        $remainingSvc = Get-Service -Name $targetServiceName -ErrorAction SilentlyContinue
        if ($remainingSvc -and -not $conflicts.ContainsKey($targetServiceName)) { return 'REVIEW' }
        if (Test-Path -LiteralPath $agentBin) { return 'REVIEW' }
        if (-not $okBin -or -not $okConfig) { return 'REVIEW' }
    } catch {
        return 'REVIEW'
    }
    if ($hasConflict) { return 'REVIEW' }
    return 'DONE'
}

function Cleanup-TunnelStep($Preflight) {
    $workerConf = Join-Path $workerRoot 'zt-worker.conf'
    $stagedConf = Join-Path $managedRoot 'zt-worker.conf'
    try {
        $state = if ($Preflight -and $Preflight.state) { $Preflight.state } else { $Preflight }
        $ownedServices = Get-EntryValue $state 'owned_services'
        $ownedTunnel = if ($ownedServices) { Get-EntryValue $ownedServices 'tunnel' } else { $null }
        if (-not $ownedTunnel) {
            return 'REVIEW'
        }
        $tunnelServiceName = Get-EntryValue $ownedTunnel 'name'
        if (-not $tunnelServiceName) { $tunnelServiceName = 'WireGuardTunnel$zt-worker' }

        $tunnelSvc = Get-Service -Name $tunnelServiceName -ErrorAction SilentlyContinue
        if ($tunnelSvc) {
            if (Test-Path -LiteralPath $wireguard) {
                $process = Start-Process -FilePath $wireguard -ArgumentList @('/uninstalltunnelservice', 'zt-worker') -Wait -PassThru
            } else {
                Stop-Service -Name $tunnelServiceName -Force -ErrorAction SilentlyContinue
                & "$env:WINDIR\System32\sc.exe" delete $tunnelServiceName *> $null
            }
        }

        $okConf = Restore-OrRemoveManagedFile $workerConf $Preflight
        if (Test-Path -LiteralPath $stagedConf) {
            Remove-Item -LiteralPath $stagedConf -Force -ErrorAction SilentlyContinue
        }

        $remainingSvc = Get-Service -Name $tunnelServiceName -ErrorAction SilentlyContinue
        if ($remainingSvc) { return 'REVIEW' }
        if (Test-Path -LiteralPath $workerConf) { return 'REVIEW' }
        if (-not $okConf) { return 'REVIEW' }
    } catch {
        return 'REVIEW'
    }
    return 'DONE'
}

function Cleanup-FirewallStep($Preflight) {
    try {
        $state = if ($Preflight -and $Preflight.state) { $Preflight.state } else { $Preflight }
        $ownedRules = Get-EntryValue $state 'owned_rules'
        if (-not $ownedRules) {
            return 'REVIEW'
        }
        $rules = @($ownedRules)
        foreach ($name in $rules) {
            Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        }
        $remaining = @(Get-NetFirewallRule -Name $rules -ErrorAction SilentlyContinue)
        if ($remaining.Count -gt 0) { return 'REVIEW' }
    } catch {
        return 'REVIEW'
    }
    return 'DONE'
}

function Cleanup-SshStep($Preflight) {
    $conflicts = $Preflight.conflicts
    $authorizedKeys = Join-Path $workerRoot 'authorized_keys'
    $sshHostPubBackup = Join-Path $workerRoot 'ssh_host_ed25519_key.pub'
    $setupStatePath = Join-Path $workerRoot 'setup-state.json'
    $hasConflict = $conflicts.ContainsKey($sshConfigPath) -or $conflicts.ContainsKey('sshd') -or $conflicts.ContainsKey('sshd_startmode')

    try {
        [void](Restore-OrRemoveManagedFile $authorizedKeys $Preflight)
        [void](Restore-OrRemoveManagedFile $sshHostPubBackup $Preflight)

        if (Test-Path -LiteralPath $setupStatePath) {
            $setupState = Get-Content -LiteralPath $setupStatePath -Raw | ConvertFrom-Json
            if (Get-Command 'Assert-WorkerState' -ErrorAction SilentlyContinue) {
                Assert-WorkerState $setupState $workerRoot
            }

            if (-not $hasConflict) {
                Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue

                $okConfig = Restore-OrRemoveManagedFile $setupState.ConfigPath $Preflight
                if (-not $okConfig) { $hasConflict = $true }

                $deps = @($setupState.SshdDependencies) -join '/'
                if (-not $deps) { $deps = '/' }
                & "$env:WINDIR\System32\sc.exe" config sshd depend= $deps *> $null

                switch ($setupState.SshdStartMode) {
                    'Auto'     { Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue }
                    'Manual'   { Set-Service -Name sshd -StartupType Manual -ErrorAction SilentlyContinue }
                    'Disabled' { Set-Service -Name sshd -StartupType Disabled -ErrorAction SilentlyContinue }
                }

                if ((Test-Path -LiteralPath $setupState.ConfigPath) -and (Test-Path -LiteralPath $sshd)) {
                    & $sshd -t -f $setupState.ConfigPath *> $null
                    if ($LASTEXITCODE -ne 0) { return 'REVIEW' }
                }

                if ($setupState.SshdWasRunning) {
                    Start-Service -Name sshd -ErrorAction SilentlyContinue
                    $currSvc = Get-Service -Name sshd -ErrorAction SilentlyContinue
                    if (-not $currSvc -or $currSvc.Status -ne 'Running') { return 'REVIEW' }
                } else {
                    $currSvc = Get-Service -Name sshd -ErrorAction SilentlyContinue
                    if ($currSvc -and $currSvc.Status -eq 'Running') { return 'REVIEW' }
                }

                $suffix = '.uninstalled-' + (Get-Date -Format 'yyyyMMddHHmmss')
                if ($setupState.HadConfig -and (Test-Path -LiteralPath $setupState.BackupPath)) {
                    Move-Item -LiteralPath $setupState.BackupPath -Destination ($setupState.BackupPath + $suffix) -Force -ErrorAction SilentlyContinue
                }
                Move-Item -LiteralPath $setupStatePath -Destination ($setupStatePath + $suffix) -Force -ErrorAction SilentlyContinue
            }
        }

        if (Test-Path -LiteralPath $authorizedKeys) { return 'REVIEW' }
        if (Test-Path -LiteralPath $sshHostPubBackup) { return 'REVIEW' }
    } catch {
        return 'REVIEW'
    }

    if ($hasConflict) { return 'REVIEW' }
    return 'DONE'
}

function Cleanup-SecretsStep($Preflight) {
    $secretFiles = @(
        (Join-Path $managedRoot 'wireguard.private'),
        (Join-Path $managedRoot 'node.token'),
        (Join-Path $managedRoot 'agent-config.json'),
        (Join-Path $managedRoot 'zt-agent.exe'),
        (Join-Path $managedRoot 'bastion_id_ed25519.pub')
    )
    try {
        foreach ($file in $secretFiles) {
            if (Test-Path -LiteralPath $file) {
                try {
                    $len = (Get-Item -LiteralPath $file).Length
                    if ($len -gt 0) {
                        $zeros = New-Object byte[] $len
                        [IO.File]::WriteAllBytes($file, $zeros)
                    }
                } catch {}
                Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($file in $secretFiles) {
            if (Test-Path -LiteralPath $file) { return 'REVIEW' }
        }
    } catch {
        return 'REVIEW'
    }
    return 'DONE'
}

function Checkpoint-Step([string]$CleanupFilePath, $CleanupJournal, [string]$StepName, [string]$Outcome) {
    $rawSteps = Get-EntryValue $CleanupJournal 'steps'
    $stepsDict = $null
    if (-not $rawSteps) {
        $stepsDict = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::OrdinalIgnoreCase)
    } elseif ($rawSteps -is [System.Collections.Generic.Dictionary[string,string]]) {
        $stepsDict = $rawSteps
    } else {
        $stepsDict = Normalize-StepsDict $rawSteps
    }

    $stepsDict[$StepName] = $Outcome

    Set-EntryValue $CleanupJournal 'steps' $stepsDict
    Set-EntryValue $CleanupJournal 'updated_at' ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())

    Write-Private $CleanupFilePath (ConvertTo-CanonicalJson $CleanupJournal)
}

function Build-Receipt($Steps, $Bundle) {
    $evidencePayload = [ordered]@{
        gateway_id = (Get-EntryValue $Bundle 'gateway_id')
        node_id = (Get-EntryValue $Bundle 'node_id')
        operation_id = (Get-EntryValue $Bundle 'operation_id')
        platform = 'windows'
        steps = [ordered]@{
            agent = (Get-StepOutcome $Steps 'agent')
            firewall = (Get-StepOutcome $Steps 'firewall')
            secrets = (Get-StepOutcome $Steps 'secrets')
            ssh = (Get-StepOutcome $Steps 'ssh')
            tunnel = (Get-StepOutcome $Steps 'tunnel')
        }
    }
    $canonJson = ConvertTo-CanonicalJson $evidencePayload
    $evidenceDigest = Hash-Text $canonJson
    return [ordered]@{
        platform = 'windows'
        steps = [ordered]@{
            agent = (Get-StepOutcome $Steps 'agent')
            tunnel = (Get-StepOutcome $Steps 'tunnel')
            firewall = (Get-StepOutcome $Steps 'firewall')
            ssh = (Get-StepOutcome $Steps 'ssh')
            secrets = (Get-StepOutcome $Steps 'secrets')
        }
        evidence_digest = $evidenceDigest
    }
}

function Invoke-CompleteOffboarding([string]$CompletionUrl, [string]$CleanupToken, $Payload, [string]$CaFilePath) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($CompletionUrl)
    $request.UserAgent = 'ZT-ServerOps/1.0'
    $request.Method = 'POST'
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    $request.Timeout = 15000
    $request.ReadWriteTimeout = 15000
    $request.ContentType = 'application/json'
    $request.Headers.Add('X-Cleanup-Token', $CleanupToken)
    if ($CaFilePath) {
        $validator = New-PinnedCaValidator $CaFilePath
        $request.ServerCertificateValidationCallback = $validator.Callback
    }

    $jsonStr = ConvertTo-CanonicalJson $Payload
    $bytes = [Text.Encoding]::UTF8.GetBytes($jsonStr)
    $request.ContentLength = $bytes.Length
    $response = $null
    try {
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) {
            Stop-Worker 'Gateway offboarding completion did not return success.'
        }
        $input = $response.GetResponseStream()
        $output = New-Object IO.MemoryStream
        try {
            $buffer = New-Object byte[] 4096
            while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $output.Write($buffer, 0, $count)
                if ($output.Length -gt 65536) {
                    Stop-Worker 'Gateway completion response exceeds 64KiB.'
                }
            }
            $reply = [Text.Encoding]::UTF8.GetString($output.ToArray()) | ConvertFrom-Json
        } finally {
            $output.Dispose()
            $input.Dispose()
        }
        if (-not $reply -or -not $reply.success) {
            Stop-Worker 'Gateway offboarding completion was unsuccessful.'
        }
        return $reply
    } catch [Net.WebException] {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        switch ($code) {
            400 { Stop-Worker 'Gateway rejected offboarding completion receipt.' }
            401 { Stop-Worker 'Offboarding cleanup token is invalid or expired.' }
            409 { Stop-Worker 'Offboarding receipt conflict or already completed on Gateway.' }
            503 { Stop-Worker 'Gateway offboarding service is temporarily unavailable; retry later.' }
            default { Stop-Worker 'Cannot reach Gateway offboarding completion endpoint; capability and receipt are preserved for retry.' }
        }
    } finally {
        if ($response) { $response.Dispose() }
    }
}

function Invoke-WorkerUninstall([string]$AuthorizationPath, [string]$CaFile) {
    Assert-LocalConsole
    if (-not $AuthorizationPath) {
        Stop-Worker 'Provide AuthorizationPath for Worker uninstall.'
    }
    Assert-TrustedManagedPath (Split-Path -Parent $managedRoot)
    Assert-TrustedManagedPath $managedRoot
    Assert-TrustedManagedPath $statePath

    $cleanupPath = Join-Path $managedRoot 'cleanup.json'
    $capabilityPath = Join-Path $managedRoot 'cleanup.capability'

    $rawBundle = Read-PrivateAuthBundle $AuthorizationPath
    if (Test-Path -LiteralPath $cleanupPath) {
        try {
            $prevCleanup = Get-Content -LiteralPath $cleanupPath -Raw | ConvertFrom-Json
        } catch {
            $prevCleanup = $null
        }
        $prevOpId = if ($prevCleanup) { Get-EntryValue $prevCleanup 'operation_id' } else { $null }
        $rawOpId = if ($rawBundle) { Get-EntryValue $rawBundle 'operation_id' } else { $null }
        if ($prevCleanup -and $prevOpId -and $prevOpId -eq $rawOpId) {
            $curState = $null
            if (Test-Path -LiteralPath $statePath) {
                $curState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            }
            if ($curState -and (Get-EntryValue $curState 'assignment')) {
                $currAsgn = Get-EntryValue $curState 'assignment'
                $curNodeId = Get-EntryValue $currAsgn 'node_id'
                $curGwId = Get-EntryValue $currAsgn 'gateway_id'
                $prevNodeId = Get-EntryValue $prevCleanup 'node_id'
                $prevGwId = Get-EntryValue $prevCleanup 'gateway_id'
                if ($curNodeId -ne $prevNodeId -or $curGwId -ne $prevGwId) {
                    Stop-Worker 'Saved cleanup belongs to a previous installation; refusing to mutate current Worker.'
                }
            }
            $prevAck = [bool](Get-EntryValue $prevCleanup 'gateway_acknowledged')
            $prevStatus = [string](Get-EntryValue $prevCleanup 'status')
            if ($prevAck -and $prevStatus -eq 'COMPLETE') {
                $prevReceipt = Get-EntryValue $prevCleanup 'receipt'
                if ($curState -and (Get-EntryValue $curState 'phase') -ne 'uninstalled') {
                    Set-EntryValue $curState 'phase' 'uninstalled'
                    Set-EntryValue $curState 'uninstalled_status' 'COMPLETE'
                    Set-EntryValue $curState 'cleanup_receipt' $prevReceipt
                    Write-Private $statePath ($curState | ConvertTo-Json -Depth 10)
                }
                if (Test-Path -LiteralPath $capabilityPath) {
                    Remove-Item -LiteralPath $capabilityPath -Force -ErrorAction SilentlyContinue
                }
                $out = [ordered]@{
                    ok = $true
                    status = 'COMPLETE'
                    operation_id = $prevOpId
                    node_id = (Get-EntryValue $prevCleanup 'node_id')
                    node_name = (Get-EntryValue $prevCleanup 'node_name')
                    receipt = $prevReceipt
                    gateway_acknowledged = $true
                    already_completed = $true
                    state_file = $statePath
                }
                [Console]::WriteLine(($out | ConvertTo-Json -Depth 6))
                return $out
            }
            # Existing SAME incomplete operation should route to cleanup-retry with bound auth
            # instead of resetting journal/steps/receipt!
            return (Invoke-WorkerCleanupRetry -AuthorizationPath $AuthorizationPath -CaFile $CaFile)
        }
    }

    $state = $null
    if (Test-Path -LiteralPath $statePath) {
        Assert-PrivateInput $statePath
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }
    if (-not $state -or -not $state.assignment) {
        Stop-Worker 'No assigned automation Worker exists to uninstall; manual review required.'
    }

    $lockPath = Join-Path $managedRoot 'install.lock'
    Assert-NoReparsePoint $lockPath
    $lockHandle = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Private-Acl $lockPath
    try {
        $workerWgPub = Get-LocalWorkerWgPublicKey $state $managedRoot
        $validated = Check-OffboardingBundle $rawBundle $state.assignment $workerWgPub
        $bundle = $validated.bundle
        $trustedOrigin = $validated.trusted_origin

        $preflight = Preflight-Uninstall $state

        $verifyReply = Invoke-VerifyOffboarding $bundle $trustedOrigin $CaFile

        Write-Private $capabilityPath ($bundle.cleanup_token + [char]10)

        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $stepsInit = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::OrdinalIgnoreCase)
        $cleanupJournal = [ordered]@{
            version = 1
            kind = 'zt-worker-cleanup'
            created_at = $now
            updated_at = $now
            operation_id = $bundle.operation_id
            node_id = $bundle.node_id
            node_name = $bundle.node_name
            node_ip = $bundle.node_ip
            gateway_id = $bundle.gateway_id
            invitation_id = $bundle.invitation_id
            wireguard_public_key = $bundle.wireguard_public_key
            completion_url = $bundle.completion_url
            registration_url = $state.assignment.registration_url
            trusted_origin = $trustedOrigin
            status = 'IN_PROGRESS'
            steps = $stepsInit
            receipt = $null
            gateway_acknowledged = $false
        }
        Write-Private $cleanupPath (ConvertTo-CanonicalJson $cleanupJournal)

        $stepList = @(
            @{ name = 'agent';    fn = { param($p) Cleanup-AgentStep $p } },
            @{ name = 'tunnel';   fn = { param($p) Cleanup-TunnelStep $p } },
            @{ name = 'firewall'; fn = { param($p) Cleanup-FirewallStep $p } },
            @{ name = 'ssh';      fn = { param($p) Cleanup-SshStep $p } },
            @{ name = 'secrets';  fn = { param($p) Cleanup-SecretsStep $p } }
        )

        foreach ($entry in $stepList) {
            $sName = $entry.name
            if ((Get-StepOutcome $cleanupJournal.steps $sName) -ne 'DONE') {
                $outcome = & $entry.fn $preflight
                Checkpoint-Step $cleanupPath $cleanupJournal $sName $outcome
            }
        }

        $allDone = $true
        foreach ($entry in $stepList) {
            if ((Get-StepOutcome $cleanupJournal.steps $entry.name) -ne 'DONE') {
                $allDone = $false
                break
            }
        }
        $status = if ($allDone) { 'COMPLETE' } else { 'NEEDS_REVIEW' }
        $receipt = Build-Receipt $cleanupJournal.steps $bundle

        Set-EntryValue $cleanupJournal 'status' $status
        Set-EntryValue $cleanupJournal 'receipt' $receipt
        Set-EntryValue $cleanupJournal 'updated_at' ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
        Write-Private $cleanupPath (ConvertTo-CanonicalJson $cleanupJournal)

        $completionPayload = [ordered]@{
            version = 1
            operation_id = $bundle.operation_id
            node_id = $bundle.node_id
            gateway_id = $bundle.gateway_id
            invitation_id = $bundle.invitation_id
            wireguard_public_key = $bundle.wireguard_public_key
            node_ip = $bundle.node_ip
            status = $status
            receipt = $receipt
        }

        $completeReply = Invoke-CompleteOffboarding $bundle.completion_url $bundle.cleanup_token $completionPayload $CaFile

        # Persist final nonsecret ack and state phase FIRST before wiping capability
        Set-EntryValue $cleanupJournal 'gateway_acknowledged' $true
        Set-EntryValue $cleanupJournal 'updated_at' ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
        Write-Private $cleanupPath (ConvertTo-CanonicalJson $cleanupJournal)

        if ($state) {
            $newPhase = if ($status -eq 'COMPLETE') { 'uninstalled' } else { 'cleanup_needs_review' }
            Set-EntryValue $state 'phase' $newPhase
            Set-EntryValue $state 'uninstalled_status' $status
            Set-EntryValue $state 'cleanup_receipt' $receipt
            Write-Private $statePath ($state | ConvertTo-Json -Depth 10)
        }

        if ($status -eq 'COMPLETE') {
            if (Test-Path -LiteralPath $capabilityPath) {
                Remove-Item -LiteralPath $capabilityPath -Force -ErrorAction SilentlyContinue
            }
        }

        $out = [ordered]@{
            ok = ($status -eq 'COMPLETE')
            status = $status
            operation_id = $bundle.operation_id
            node_id = $bundle.node_id
            node_name = $bundle.node_name
            receipt = $receipt
            gateway_acknowledged = $true
            state_file = $statePath
        }
        $outJson = $out | ConvertTo-Json -Depth 6
        [Console]::WriteLine($outJson)
        return $out
    } finally {
        if ($lockHandle) { $lockHandle.Dispose() }
    }
}

function Invoke-WorkerCleanupRetry([string]$AuthorizationPath, [string]$CaFile) {
    Assert-LocalConsole
    $managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
    $statePath = Join-Path $managedRoot 'state.json'
    $cleanupPath = Join-Path $managedRoot 'cleanup.json'
    $capabilityPath = Join-Path $managedRoot 'cleanup.capability'

    if (-not (Test-Path -LiteralPath $cleanupPath)) {
        if ($AuthorizationPath) {
            return Invoke-WorkerUninstall -AuthorizationPath $AuthorizationPath -CaFile $CaFile
        }
        Stop-Worker 'No cleanup in progress to retry.'
    }

    $cleanupJournal = Get-Content -LiteralPath $cleanupPath -Raw | ConvertFrom-Json
    if ($cleanupJournal) {
        $cleanupJournal.steps = Normalize-StepsDict (Get-EntryValue $cleanupJournal 'steps')
    }
    $state = $null
    if (Test-Path -LiteralPath $statePath) {
        Assert-PrivateInput $statePath
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }

    $journalAck = [bool](Get-EntryValue $cleanupJournal 'gateway_acknowledged')
    $journalStatus = [string](Get-EntryValue $cleanupJournal 'status')
    $journalReceipt = Get-EntryValue $cleanupJournal 'receipt'
    $journalOpId = Get-EntryValue $cleanupJournal 'operation_id'
    $journalNodeId = Get-EntryValue $cleanupJournal 'node_id'
    $journalNodeName = Get-EntryValue $cleanupJournal 'node_name'
    $journalGwId = Get-EntryValue $cleanupJournal 'gateway_id'

    # If already completed, ensure terminalization is finished and return
    if ($journalAck -and $journalStatus -eq 'COMPLETE') {
        if ($state -and (Get-EntryValue $state 'assignment')) {
            $currAsgn = Get-EntryValue $state 'assignment'
            $cNodeId = Get-EntryValue $currAsgn 'node_id'
            $cGwId = Get-EntryValue $currAsgn 'gateway_id'
            if ($cNodeId -ne $journalNodeId -or $cGwId -ne $journalGwId) {
                Stop-Worker 'Saved cleanup belongs to a previous installation; refusing to mutate current Worker.'
            }
        }
        if ($state -and (Get-EntryValue $state 'phase') -ne 'uninstalled') {
            Set-EntryValue $state 'phase' 'uninstalled'
            Set-EntryValue $state 'uninstalled_status' 'COMPLETE'
            Set-EntryValue $state 'cleanup_receipt' $journalReceipt
            Write-Private $statePath ($state | ConvertTo-Json -Depth 10)
        }
        if (Test-Path -LiteralPath $capabilityPath) {
            Remove-Item -LiteralPath $capabilityPath -Force -ErrorAction SilentlyContinue
        }
        $out = [ordered]@{
            ok = $true
            status = 'COMPLETE'
            operation_id = $journalOpId
            node_id = $journalNodeId
            node_name = $journalNodeName
            receipt = $journalReceipt
            gateway_acknowledged = $true
            already_completed = $true
            state_file = $statePath
        }
        $outJson = $out | ConvertTo-Json -Depth 6
        [Console]::WriteLine($outJson)
        return $out
    }

    if (-not $state -or -not (Get-EntryValue $state 'assignment')) {
        Stop-Worker 'Worker state lacks assignment record; manual review required.'
    }
    $assignment = Get-EntryValue $state 'assignment'
    foreach ($k in @('node_id', 'invitation_id', 'gateway_id', 'node_ip')) {
        $jVal = Get-EntryValue $cleanupJournal $k
        $aVal = Get-EntryValue $assignment $k
        if ($jVal -cne $aVal) {
            Stop-Worker "Saved cleanup operation $k does not match current Worker assignment."
        }
    }

    $workerWgPub = Get-LocalWorkerWgPublicKey $state $managedRoot
    $jWgPub = Get-EntryValue $cleanupJournal 'wireguard_public_key'
    if ($jWgPub -cne $workerWgPub) {
        Stop-Worker 'Saved cleanup operation wireguard_public_key does not match local Worker identity.'
    }

    $asgnRegUrl = Get-EntryValue $assignment 'registration_url'
    $regUri = $null
    if (-not $asgnRegUrl -or -not [Uri]::TryCreate($asgnRegUrl, [UriKind]::Absolute, [ref]$regUri) -or
        $regUri.Scheme -ne 'https' -or $regUri.UserInfo -or $regUri.Query -or $regUri.Fragment) {
        Stop-Worker 'Worker registration URL is not a valid HTTPS URL.'
    }
    $trustedOrigin = "$($regUri.Scheme)://$($regUri.Authority)"
    $expectedCompletion = "$trustedOrigin/api/offboarding/complete"

    $journalCompletion = Get-EntryValue $cleanupJournal 'completion_url'
    if (-not $journalCompletion -or $journalCompletion -cne $expectedCompletion) {
        Stop-Worker 'completion_url in journal does not match trusted Gateway HTTPS offboarding endpoint.'
    }

    $token = $null
    if ($AuthorizationPath) {
        $rawBundle = Read-PrivateAuthBundle $AuthorizationPath
        $checked = Check-OffboardingBundle $rawBundle $assignment $workerWgPub
        $rawOpId = Get-EntryValue $rawBundle 'operation_id'
        if ($rawOpId -ne $journalOpId) {
            Stop-Worker 'Provided authorization bundle does not match the saved cleanup operation.'
        }
        $token = Get-EntryValue $rawBundle 'cleanup_token'
        Write-Private $capabilityPath ($token + [char]10)
    } elseif (Test-Path -LiteralPath $capabilityPath) {
        $token = (Get-Content -LiteralPath $capabilityPath -Raw).Trim()
    }

    if (-not $token -or $token -notmatch '^[0-9a-f]{64}$') {
        Stop-Worker 'No valid cleanup capability token available for retry; provide authorization bundle.'
    }

    # Check if this is a RECEIPT-ONLY retry
    $durableReceipt = Get-EntryValue $cleanupJournal 'receipt'
    $durableDigest = if ($durableReceipt) { Get-EntryValue $durableReceipt 'evidence_digest' } else { $null }
    $isReceiptOnly = (
        $journalStatus -eq 'COMPLETE' -and
        $null -ne $durableReceipt -and
        $null -ne $durableDigest -and
        [string]$durableDigest -ne ''
    )

    if ($isReceiptOnly) {
        $completionPayload = [ordered]@{
            version = 1
            operation_id = $journalOpId
            node_id = $journalNodeId
            gateway_id = $journalGwId
            invitation_id = (Get-EntryValue $cleanupJournal 'invitation_id')
            wireguard_public_key = (Get-EntryValue $cleanupJournal 'wireguard_public_key')
            node_ip = (Get-EntryValue $cleanupJournal 'node_ip')
            status = 'COMPLETE'
            receipt = $durableReceipt
        }

        [void](Invoke-CompleteOffboarding $expectedCompletion $token $completionPayload $CaFile)

        Set-EntryValue $cleanupJournal 'gateway_acknowledged' $true
        Set-EntryValue $cleanupJournal 'updated_at' ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
        Write-Private $cleanupPath (ConvertTo-CanonicalJson $cleanupJournal)

        if ($state) {
            Set-EntryValue $state 'phase' 'uninstalled'
            Set-EntryValue $state 'uninstalled_status' 'COMPLETE'
            Set-EntryValue $state 'cleanup_receipt' $durableReceipt
            Write-Private $statePath ($state | ConvertTo-Json -Depth 10)
        }

        if (Test-Path -LiteralPath $capabilityPath) {
            Remove-Item -LiteralPath $capabilityPath -Force -ErrorAction SilentlyContinue
        }

        $out = [ordered]@{
            ok = $true
            status = 'COMPLETE'
            operation_id = $journalOpId
            node_id = $journalNodeId
            node_name = $journalNodeName
            receipt = $durableReceipt
            gateway_acknowledged = $true
            state_file = $statePath
        }
        $outJson = $out | ConvertTo-Json -Depth 6
        [Console]::WriteLine($outJson)
        return $out
    }

    $asgnNodeName = Get-EntryValue $assignment 'node_name'
    $verifyBundle = [pscustomobject][ordered]@{
        version = 1
        operation_id = $journalOpId
        gateway_id = $journalGwId
        node_id = $journalNodeId
        node_name = if ($journalNodeName) { $journalNodeName } else { $asgnNodeName }
        invitation_id = (Get-EntryValue $cleanupJournal 'invitation_id')
        wireguard_public_key = (Get-EntryValue $cleanupJournal 'wireguard_public_key')
        node_ip = (Get-EntryValue $cleanupJournal 'node_ip')
        cleanup_token = $token
    }
    [void](Invoke-VerifyOffboarding $verifyBundle $trustedOrigin $CaFile)

    $lockPath = Join-Path $managedRoot 'install.lock'
    Assert-NoReparsePoint $lockPath
    $lockHandle = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Private-Acl $lockPath
    try {
        $preflight = Preflight-Uninstall $state

        $stepList = @(
            @{ name = 'agent';    fn = { param($p) Cleanup-AgentStep $p } },
            @{ name = 'tunnel';   fn = { param($p) Cleanup-TunnelStep $p } },
            @{ name = 'firewall'; fn = { param($p) Cleanup-FirewallStep $p } },
            @{ name = 'ssh';      fn = { param($p) Cleanup-SshStep $p } },
            @{ name = 'secrets';  fn = { param($p) Cleanup-SecretsStep $p } }
        )

        foreach ($entry in $stepList) {
            $sName = $entry.name
            if ((Get-StepOutcome $cleanupJournal.steps $sName) -ne 'DONE') {
                $outcome = & $entry.fn $preflight
                Checkpoint-Step $cleanupPath $cleanupJournal $sName $outcome
            }
        }

        $allDone = $true
        foreach ($entry in $stepList) {
            if ((Get-StepOutcome $cleanupJournal.steps $entry.name) -ne 'DONE') {
                $allDone = $false
                break
            }
        }
        $status = if ($allDone) { 'COMPLETE' } else { 'NEEDS_REVIEW' }

        $receipt = Get-EntryValue $cleanupJournal 'receipt'
        if (-not $receipt -or $journalStatus -ne $status) {
            $receipt = Build-Receipt $cleanupJournal.steps $cleanupJournal
            Set-EntryValue $cleanupJournal 'receipt' $receipt
        }

        Set-EntryValue $cleanupJournal 'status' $status
        Set-EntryValue $cleanupJournal 'updated_at' ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
        Write-Private $cleanupPath (ConvertTo-CanonicalJson $cleanupJournal)

        $completionPayload = [ordered]@{
            version = 1
            operation_id = $journalOpId
            node_id = $journalNodeId
            gateway_id = $journalGwId
            invitation_id = (Get-EntryValue $cleanupJournal 'invitation_id')
            wireguard_public_key = (Get-EntryValue $cleanupJournal 'wireguard_public_key')
            node_ip = (Get-EntryValue $cleanupJournal 'node_ip')
            status = $status
            receipt = $receipt
        }

        $completeReply = Invoke-CompleteOffboarding (Get-EntryValue $cleanupJournal 'completion_url') $token $completionPayload $CaFile

        Set-EntryValue $cleanupJournal 'gateway_acknowledged' $true
        Set-EntryValue $cleanupJournal 'updated_at' ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
        Write-Private $cleanupPath (ConvertTo-CanonicalJson $cleanupJournal)

        if ($state) {
            $newPhase = if ($status -eq 'COMPLETE') { 'uninstalled' } else { 'cleanup_needs_review' }
            Set-EntryValue $state 'phase' $newPhase
            Set-EntryValue $state 'uninstalled_status' $status
            Set-EntryValue $state 'cleanup_receipt' $receipt
            Write-Private $statePath ($state | ConvertTo-Json -Depth 10)
        }

        if ($status -eq 'COMPLETE') {
            if (Test-Path -LiteralPath $capabilityPath) {
                Remove-Item -LiteralPath $capabilityPath -Force -ErrorAction SilentlyContinue
            }
        }

        $out = [ordered]@{
            ok = ($status -eq 'COMPLETE')
            status = $status
            operation_id = $journalOpId
            node_id = $journalNodeId
            node_name = $journalNodeName
            receipt = $receipt
            gateway_acknowledged = $true
            state_file = $statePath
        }
        $outJson = $out | ConvertTo-Json -Depth 6
        [Console]::WriteLine($outJson)
        return $out
    } finally {
        if ($lockHandle) { $lockHandle.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.' -and -not $ExportFunctionsOnly) {
    try {
        if ($Action -eq 'uninstall') {
            Invoke-WorkerUninstall -AuthorizationPath $AuthorizationPath -CaFile $CaFile
        } else {
            Invoke-WorkerCleanupRetry -AuthorizationPath $AuthorizationPath -CaFile $CaFile
        }
    } catch {
        $message = if ($_.Exception.Message.StartsWith('ZT: ')) { $_.Exception.Message.Substring(4) } else { $_.Exception.Message }
        [Console]::Error.WriteLine(([ordered]@{ ok = $false; error = $message } | ConvertTo-Json -Depth 3))
        exit 1
    }
}
