#Requires -Version 5.1
<# Explicit dedicated Windows Worker installer. No secret command-line arguments. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('check','install','status','uninstall','cleanup-retry')][string]$Action,
    [string]$InvitationPath,
    [string]$AgentBinaryPath,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$AgentSHA256,
    [string]$AuthorizationPath,
    [string]$CaFile,
    [string[]]$TransportInterfaceAlias,
    [switch]$DedicatedWorker,
    [switch]$InstallPrerequisites,
    [string]$WireGuardInstallerPath,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$WireGuardInstallerSHA256,
    [ValidateRange(15,600)][int]$WaitSeconds=120
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
$statePath = Join-Path $managedRoot 'state.json'
$workerStatePath = Join-Path $env:ProgramData 'ZT-ServerOps\worker\setup-state.json'
$wg = Join-Path $env:ProgramFiles 'WireGuard\wg.exe'
$wireguard = Join-Path $env:ProgramFiles 'WireGuard\wireguard.exe'
$keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
$hostKey = Join-Path $env:ProgramData 'ssh\ssh_host_ed25519_key'
$agentServiceName='ZTServerOpsAgent'
$lockHandle=$null
. (Join-Path $repo 'deploy\windows\worker-common.ps1')

function Stop-Worker([string]$Message) { throw [InvalidOperationException]::new('ZT: '+$Message) }
function Hash-Text([string]$Text) {
    $hasher=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','').ToLowerInvariant() }
    finally {$hasher.Dispose()}
}
function Check-WindowsBinary([byte[]]$Bytes,[string]$Architecture) {
    if($Bytes.Length -lt 64 -or $Bytes[0] -ne 77 -or $Bytes[1] -ne 90){Stop-Worker 'Agent must be a trusted64-bit Windows executable.'}
    $offset=[BitConverter]::ToUInt32($Bytes,60)
    if($offset -gt ($Bytes.Length-6) -or $Bytes[$offset] -ne 80 -or $Bytes[$offset+1] -ne 69 -or $Bytes[$offset+2] -ne 0 -or $Bytes[$offset+3] -ne 0){Stop-Worker 'Agent PE executable header is invalid.'}
    $machine=[BitConverter]::ToUInt16($Bytes,$offset+4)
    $expected=switch($Architecture.ToUpperInvariant()){'AMD64'{0x8664};'ARM64'{0xaa64};default{0}}
    if(-not$expected -or $machine -ne $expected){Stop-Worker 'Agent architecture does not match this supported64-bit Windows host.'}
}
function Private-Acl([string]$Path) {
    Assert-NoReparsePoint $Path
    $acl=Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true,$false)
    foreach($entry in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($entry)}
    foreach($sid in @('S-1-5-18','S-1-5-32-544')){
        $who=New-Object Security.Principal.SecurityIdentifier($sid)
        $inherit=if((Get-Item -LiteralPath $Path).PSIsContainer){'ContainerInherit,ObjectInherit'}else{'None'}
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who,'FullControl',$inherit,'None','Allow')))
    }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-PrivateInput([string]$Path) {
    Assert-NoReparsePoint $Path
    $file=Get-Item -LiteralPath $Path
    if($file.PSIsContainer -or $file.Length -gt 65536){Stop-Worker 'Invitation must be a regular file of at most64KiB.'}
    $current=$null
    try{$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}catch{}
    $allowed=@('S-1-5-18','S-1-5-32-544')
    if($current){$allowed+=$current}
    $acl=Get-Acl -LiteralPath $Path
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){Stop-Worker 'Invitation owner is not trusted.'}
    foreach($entry in @($acl.Access)){
        $sid=$entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($entry.AccessControlType -eq 'Allow' -and $sid -notin $allowed){Stop-Worker 'Invitation must not be readable by other Windows identities.'}
    }
}
function Write-Private([string]$Path,[string]$Text) {
    Assert-NoReparsePoint $Path
    if(-not(Test-Path -LiteralPath $Path)){New-Item -Path $Path -ItemType File | Out-Null}
    Private-Acl $Path
    $temporary=$Path+'.new'
    Assert-NoReparsePoint $temporary
    if(-not(Test-Path -LiteralPath $temporary)){New-Item -Path $temporary -ItemType File | Out-Null}
    Private-Acl $temporary
    [IO.File]::WriteAllText($temporary,$Text,(New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    Private-Acl $Path
}
function Save-State($State) {Write-Private $statePath ($State | ConvertTo-Json -Depth 10)}

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
function Read-State {
    if(-not(Test-Path -LiteralPath $statePath)){return $null}
    Assert-TrustedManagedPath $managedRoot
    Assert-PrivateInput $statePath
    $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if($state.version -ne 1 -or $state.kind -ne 'zt-worker-automation'){Stop-Worker 'Unrecognized Worker state; preserve it and review manually.'}
    return $state
}
function Ssh-Public([string]$Value) {
    if($Value -match '[\r\n]' -or $Value -notmatch '^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})( [^\r\n]*)?$'){Stop-Worker 'Expected one Ed25519 SSH public key.'}
    try{$blob=[Convert]::FromBase64String($Matches[1])}catch{Stop-Worker 'SSH public key encoding is invalid.'}
    $prefix=[byte[]](0,0,0,11,115,115,104,45,101,100,50,53,53,49,57,0,0,0,32)
    if($blob.Length -ne 51){Stop-Worker 'SSH public key length is invalid.'}
    for($i=0;$i -lt $prefix.Length;$i++){if($blob[$i] -ne $prefix[$i]){Stop-Worker 'SSH public key structure is invalid.'}}
    return 'ssh-ed25519 '+[Convert]::ToBase64String($blob)
}
function Check-Invitation($Invite,[bool]$AllowExpired) {
    $expected=@('version','gateway_id','registration_url','wireguard_endpoint','wireguard_public_key','gateway_vpn_ip','bastion_public_key','invitation_id','join_token','expires_at','node_name','node_type','worker_os','ssh_username')
    if(@(Compare-Object @($Invite.PSObject.Properties.Name | Sort-Object) @($expected | Sort-Object)).Count -or $Invite.version -is [bool] -or $Invite.version -ne 1){Stop-Worker 'Unsupported invitation format.'}
    foreach($name in $expected | Where-Object {$_ -ne 'version'}){if($Invite.$name -isnot [string]){Stop-Worker 'Invitation fields must be strings.'}}
    try{$public=[Convert]::FromBase64String($Invite.wireguard_public_key)}catch{Stop-Worker 'WireGuard public key is invalid.'}
    if($public.Length -ne 32 -or [Convert]::ToBase64String($public) -cne $Invite.wireguard_public_key){Stop-Worker 'WireGuard public key is invalid.'}
    $hasher=[Security.Cryptography.SHA256]::Create()
    try{$gateway='sha256:'+([BitConverter]::ToString($hasher.ComputeHash($public))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}
    if($gateway -cne $Invite.gateway_id){Stop-Worker 'Gateway identity does not match its WireGuard public key.'}
    $uri=$null
    if(-not[Uri]::TryCreate($Invite.registration_url,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/api/enrollment/claim'){Stop-Worker 'Use a verified HTTPS enrollment URL.'}
    $guid=[Guid]::Empty
    if(-not[Guid]::TryParse($Invite.invitation_id,[ref]$guid)){Stop-Worker 'Invitation identifier is invalid.'}
    if($Invite.wireguard_endpoint -notmatch '^([0-9.]+):([0-9]{1,5})$'){Stop-Worker 'WireGuard endpoint must be IPv4:port.'}
    try{$address=[Net.IPAddress]::Parse($Matches[1]);$port=[int]$Matches[2]}catch{Stop-Worker 'WireGuard endpoint is invalid.'}
    if($address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $port -lt 1 -or $port -gt 65535){Stop-Worker 'WireGuard endpoint is invalid.'}
    $expiry=[DateTimeOffset]::MinValue
    if(-not[DateTimeOffset]::TryParse($Invite.expires_at,[ref]$expiry)){Stop-Worker 'Invitation expiry is invalid.'}
    if(-not$AllowExpired -and $expiry -le [DateTimeOffset]::UtcNow){Stop-Worker 'Invitation has expired; request a new one.'}
    if($Invite.worker_os -ne 'windows' -or $Invite.node_type -notin @('VM','BARE_METAL') -or $Invite.gateway_vpn_ip -ne '10.100.0.1'){Stop-Worker 'Invitation does not match this Windows Worker.'}
    if($Invite.node_name -notmatch '^[a-zA-Z0-9_-]{3,64}$' -or $Invite.ssh_username -notmatch '^[a-z][a-z0-9_-]{0,19}$' -or $Invite.ssh_username -in @('root','admin','administrator')){Stop-Worker 'Worker name or ordinary SSH account is invalid.'}
    if($Invite.join_token -notmatch '^[A-Za-z0-9_-]{32,128}$'){Stop-Worker 'Invitation code is invalid.'}
    [void](Ssh-Public $Invite.bastion_public_key)
    $canonical=[ordered]@{}
    foreach($name in $expected | Sort-Object){$canonical[$name]=$Invite.$name}
    return Hash-Text ($canonical | ConvertTo-Json -Compress)
}
function Validate-Assignment($Reply,$Invite) {
    if($Reply.version -ne 1 -or $Reply.status -notin @('PENDING','READY')){Stop-Worker 'Unsupported Gateway enrollment response.'}
    foreach($name in @('gateway_id','invitation_id','registration_url','node_name','node_type','worker_os','ssh_username','gateway_vpn_ip','wireguard_endpoint','wireguard_public_key')){
        if($Reply.$name -cne $Invite.$name){Stop-Worker 'Gateway response differs from the trusted invitation.'}
    }
    if((Ssh-Public $Reply.bastion_public_key) -cne (Ssh-Public $Invite.bastion_public_key)){Stop-Worker 'Gateway SSH identity changed.'}
    if($Reply.gateway_api_url -ne 'http://10.100.0.1:3000' -or $Reply.node_ip -notmatch '^10\.100\.0\.([0-9]{1,3})$' -or [int]$Matches[1] -lt 3 -or [int]$Matches[1] -gt 254){Stop-Worker 'Gateway assigned an invalid Worker address.'}
    $guid=[Guid]::Empty
    if(-not[Guid]::TryParse($Reply.node_id,[ref]$guid)){Stop-Worker 'Gateway node identifier is invalid.'}
    if($Reply.peer_ready -isnot [bool] -or $Reply.peer_ready -ne ($Reply.status -eq 'READY')){Stop-Worker 'Peer acknowledgement is inconsistent.'}
    foreach($name in @('peer_applied','heartbeat_recent','ssh_authenticated')){if($Reply.verification.$name -isnot [bool]){Stop-Worker 'Gateway verification evidence is missing.'}}
    return $Reply
}
function New-PinnedCaValidator([string]$Path) {
    # HttpWebRequest can call certificate validation on a .NET worker thread.
    # A compiled delegate avoids invoking a PowerShell scriptblock without a runspace.
    if(-not('ZTWorkerPinnedCa' -as [type])) {
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
    Assert-NoReparsePoint $Path
    $caPath=(Resolve-Path -LiteralPath $Path).Path
    $caText=[IO.File]::ReadAllText($caPath)
    if($caText -match '(?s)-----BEGIN CERTIFICATE-----\s*(.*?)\s*-----END CERTIFICATE-----') {
        $der=[Convert]::FromBase64String(($Matches[1] -replace '\s',''))
    } else { $der=[IO.File]::ReadAllBytes($caPath) }
    return New-Object ZTWorkerPinnedCa -ArgumentList @(,$der)
}
function Invoke-Claim($Invite,$Payload) {
    [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
    $request=[Net.HttpWebRequest]::Create($Invite.registration_url)
    $request.UserAgent='ZT-ServerOps/1.0'
    $request.Method='POST';$request.AllowAutoRedirect=$false;$request.Proxy=$null
    $request.Timeout=15000;$request.ReadWriteTimeout=15000;$request.ContentType='application/json'
    $request.Headers.Add('X-Enrollment-Token',$Invite.join_token)
    if($CaFile){
        $validator=New-PinnedCaValidator $CaFile
        $request.ServerCertificateValidationCallback=$validator.Callback
    }
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Compress))
    $request.ContentLength=$bytes.Length
    $response=$null
    try{
        $stream=$request.GetRequestStream();try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
        $response=$request.GetResponse()
        if([int]$response.StatusCode -notin @(200,202)){Stop-Worker 'Gateway enrollment redirect or unexpected status was refused.'}
        $input=$response.GetResponseStream();$output=New-Object IO.MemoryStream
        try{
            $buffer=New-Object byte[] 4096
            while(($count=$input.Read($buffer,0,$buffer.Length)) -gt 0){$output.Write($buffer,0,$count);if($output.Length -gt 65536){Stop-Worker 'Enrollment response exceeds64KiB.'}}
            $reply=[Text.Encoding]::UTF8.GetString($output.ToArray()) | ConvertFrom-Json
        }finally{$output.Dispose();$input.Dispose()}
        return Validate-Assignment $reply $Invite
    }catch [Net.WebException]{
        $code=if($_.Exception.Response){[int]$_.Exception.Response.StatusCode}else{0}
        switch($code){
            400 {Stop-Worker 'Gateway rejected the enrollment fields.'}
            401 {Stop-Worker 'Invitation code is invalid.'}
            409 {Stop-Worker 'Invitation is already bound to a different Worker identity.'}
            410 {Stop-Worker 'Invitation is expired or revoked.'}
            429 {Stop-Worker 'Enrollment is rate limited; retry with the same identity later.'}
            503 {Stop-Worker 'Gateway enrollment is temporarily unavailable; retry with the same identity.'}
            default {Stop-Worker 'Verified HTTPS enrollment failed; check the trusted CA, URL and network.'}
        }
    }finally{if($response){$response.Dispose()}}
}
function Wait-Claim($Invite,$Payload,[bool]$Full) {
    $until=[DateTime]::UtcNow.AddSeconds($WaitSeconds)
    do{
        $reply=Invoke-Claim $Invite $Payload
        if($reply.peer_ready -and (-not$Full -or ($reply.verification.peer_applied -and $reply.verification.heartbeat_recent -and $reply.verification.ssh_authenticated))){return $reply}
        if([DateTime]::UtcNow -ge $until){Stop-Worker 'Gateway checks are incomplete; rerun with the same saved Worker identity.'}
        Start-Sleep -Milliseconds 3200
    }while($true)
}
function Invoke-TrustedScript([string]$Path,[string[]]$Arguments) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $text=& "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Path @Arguments 2>&1
        if($LASTEXITCODE -ne 0){
            $detail = ($text -join "`n")
            Stop-Worker ("A Worker setup/check step failed ($Path):`n" + $detail)
        }
        return ($text -join "`n")
    } finally {
        $ErrorActionPreference = $prevEap
    }
}
function Check-Local($Assignment) {
    $services=[ordered]@{}
    foreach($name in @('sshd','WireGuardTunnel$zt-worker','ZTServerOpsAgent')){$s=Get-Service -Name $name -ErrorAction SilentlyContinue;$services[$name]=[bool]($s -and $s.Status -eq 'Running')}
    $handshake=$false
    if(Test-Path -LiteralPath $wg){
        $lines=@(& $wg show zt-worker latest-handshakes 2>$null)
        foreach($line in $lines){$parts="$line" -split '\s+';if($parts.Count -eq 2 -and $parts[1] -match '^\d+$'){$age=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-[long]$parts[1];if($age -gt 0 -and $age -lt 180){$handshake=$true}}}
    }
    $ready=$false
    try{
        $request=[Net.HttpWebRequest]::Create('http://10.100.0.1:3000/readyz');$request.UserAgent='ZT-ServerOps/1.0';$request.AllowAutoRedirect=$false;$request.Proxy=$null;$request.Timeout=5000
        $response=$request.GetResponse();try{$reader=New-Object IO.StreamReader($response.GetResponseStream());try{$body=$reader.ReadToEnd() | ConvertFrom-Json;$ready=([int]$response.StatusCode -eq 200 -and $body.status -eq 'READY')}finally{$reader.Dispose()}}finally{$response.Dispose()}
    }catch{}
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)
    $onlyVpn=$listeners.Count -gt 0 -and @($listeners | Where-Object {$_.LocalAddress -ne $Assignment.node_ip}).Count -eq 0
    return [ordered]@{services=$services;wireguard_handshake_recent=$handshake;gateway_ready=$ready;ssh_only_vpn=[bool]$onlyVpn}
}
function Local-Ok($Check){return @($Check.services.Values | Where-Object {-not$_}).Count -eq 0 -and $Check.wireguard_handshake_recent -and $Check.gateway_ready -and $Check.ssh_only_vpn}

try{
    if($env:OS -ne 'Windows_NT' -or -not[Environment]::Is64BitOperatingSystem -or -not[Environment]::Is64BitProcess){Stop-Worker 'A64-bit Windows Worker and64-bit PowerShell process are required.'}
    $isAdmin=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $state=Read-State
    if($Action -eq 'status'){
        if(-not$state -or -not$state.assignment){Stop-Worker 'No assigned automation Worker exists.'}
        $checks=Check-Local $state.assignment
        [ordered]@{ok=$false;scope='local_checks_only';phase=$state.phase;checks=$checks;note='Use install with the original invitation for current authenticated Gateway verification.'} | ConvertTo-Json -Depth 8
        exit 2
    }
    if($Action -in @('uninstall','cleanup-retry')){
        $auth = $AuthorizationPath
        $ca = $CaFile
        . (Join-Path $PSScriptRoot 'worker-uninstall.ps1') -ExportFunctionsOnly
        if($Action -eq 'uninstall'){
            Invoke-WorkerUninstall -AuthorizationPath $auth -CaFile $ca
        }else{
            Invoke-WorkerCleanupRetry -AuthorizationPath $auth -CaFile $ca
        }
        exit 0
    }
    if($state -and $state.phase -eq 'uninstalled'){
        $archiveDir = Join-Path $managedRoot 'archive'
        if(-not(Test-Path -LiteralPath $archiveDir)){New-Item -Path $archiveDir -ItemType Directory | Out-Null;Private-Acl $archiveDir}
        $archivedState = Join-Path $archiveDir ('state.uninstalled-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.json')
        Copy-Item -LiteralPath $statePath -Destination $archivedState -Force
        $cleanupPath = Join-Path $managedRoot 'cleanup.json'
        if(Test-Path -LiteralPath $cleanupPath){
            $archivedCleanup = Join-Path $archiveDir ('cleanup.uninstalled-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.json')
            Move-Item -LiteralPath $cleanupPath -Destination $archivedCleanup -Force
        }
        $capPath = Join-Path $managedRoot 'cleanup.capability'
        if(Test-Path -LiteralPath $capPath){Remove-Item -LiteralPath $capPath -Force -ErrorAction SilentlyContinue}
        $state = $null
    }
    if(-not$InvitationPath -or -not$AgentBinaryPath -or -not$AgentSHA256){Stop-Worker 'Provide InvitationPath, AgentBinaryPath and its trusted AgentSHA256.'}
    Assert-PrivateInput $InvitationPath
    $invite=Get-Content -LiteralPath $InvitationPath -Raw | ConvertFrom-Json
    $fingerprint=Check-Invitation $invite ([bool]$state)
    Assert-NoReparsePoint $AgentBinaryPath
    if((Get-FileHash -LiteralPath $AgentBinaryPath -Algorithm SHA256).Hash -ine $AgentSHA256){Stop-Worker 'Agent SHA256 does not match; nothing was installed.'}
    $binary=[IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $AgentBinaryPath).Path)
    Check-WindowsBinary $binary $env:PROCESSOR_ARCHITECTURE
    if($state -and ($state.invite_fingerprint -cne $fingerprint -or $state.agent_sha256 -ine $AgentSHA256)){Stop-Worker 'Existing Worker identity/binary differs; no overwrite was performed.'}
    $issues=New-Object Collections.Generic.List[string]
    if((Get-CimInstance Win32_ComputerSystem).PartOfDomain){$issues.Add('Domain-joined hosts require policy review; this installer targets dedicated workgroup machines.')}
    if(-not(Test-Path -LiteralPath $keygen) -and -not$InstallPrerequisites){$issues.Add('Install Windows OpenSSH Server or use InstallPrerequisites.')}
    if(-not(Test-Path -LiteralPath $wg)){
        if(-not$InstallPrerequisites -or -not$WireGuardInstallerPath -or -not$WireGuardInstallerSHA256){$issues.Add('Provide official local WireGuard MSI and its trusted SHA256 with InstallPrerequisites.')}
        elseif((Get-FileHash -LiteralPath $WireGuardInstallerPath -Algorithm SHA256).Hash -ine $WireGuardInstallerSHA256){$issues.Add('WireGuard installer SHA256 does not match.')}
    }
    if(-not$state -and ((Test-Path -LiteralPath $workerStatePath) -or (Test-Path -LiteralPath (Join-Path $env:ProgramData 'ZT-ServerOps\agent')) -or (Get-Service -Name 'WireGuardTunnel$zt-worker' -ErrorAction SilentlyContinue) -or (Get-Service -Name $agentServiceName -ErrorAction SilentlyContinue))){$issues.Add('Unowned existing Worker services/state must be preserved and reviewed manually.')}
    $existingSshUser=Get-LocalUser -Name $invite.ssh_username -ErrorAction SilentlyContinue
    if($existingSshUser){
        if(-not$existingSshUser.Enabled){$issues.Add('Existing SSH account is disabled; use an enabled ordinary account.')}
        $administrators=Get-LocalGroup -SID 'S-1-5-32-544'
        if(@(Get-LocalGroupMember -Group $administrators | Where-Object {$_.SID -eq $existingSshUser.SID}).Count){$issues.Add('Existing SSH account has administrator privileges; use an ordinary dedicated account.')}
    }
    if(-not$TransportInterfaceAlias){$TransportInterfaceAlias=@(Get-NetAdapter | Where-Object {$_.Status -eq 'Up' -and $_.Name -ne 'zt-worker'} | Select-Object -ExpandProperty Name)}
    if(-not$TransportInterfaceAlias.Count){$issues.Add('No active transport interface was found.')}
    foreach($name in $TransportInterfaceAlias){if($name -match '[*?\[\]]' -or $name -eq 'zt-worker'){$issues.Add('Transport interfaces must be explicit non-WireGuard adapter names.')}}
    if($isAdmin){try{Assert-FirewallProfiles (@($TransportInterfaceAlias)+@('zt-worker'))}catch{$issues.Add('All Windows firewall profiles must be enabled with default inbound Block.')}}
    if($Action -eq 'check'){
        [ordered]@{scope='read_only_preflight';can_install=($issues.Count -eq 0);issues=$issues.ToArray();node_name=$invite.node_name;gateway_id=$invite.gateway_id;existing_install=[bool]$state;note='Install requires an Administrator console and DedicatedWorker. Independent Internet and reboot checks remain separate.'} | ConvertTo-Json -Depth 5
        if($issues.Count){exit 2}else{exit 0}
    }
    if(-not$isAdmin -or -not$DedicatedWorker){Stop-Worker 'Install requires an elevated local console and DedicatedWorker.'}
    if($env:SSH_CONNECTION){Stop-Worker 'Do not change Worker SSH/network configuration through an SSH connection.'}
    if($issues.Count){Stop-Worker ($issues -join ' ')}
    Assert-TrustedManagedPath (Split-Path -Parent $managedRoot)
    Assert-TrustedManagedPath $managedRoot
    if(-not(Test-Path -LiteralPath (Split-Path -Parent $managedRoot))){New-Item -Path (Split-Path -Parent $managedRoot) -ItemType Directory | Out-Null}
    if(-not(Test-Path -LiteralPath $managedRoot)){New-Item -Path $managedRoot -ItemType Directory | Out-Null}
    Private-Acl $managedRoot
    $lockPath=Join-Path $managedRoot 'install.lock';Assert-NoReparsePoint $lockPath
    $lockHandle=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);Private-Acl $lockPath
    if(-not(Test-Path -LiteralPath $keygen)){
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    }
    if(-not(Test-Path -LiteralPath $wg)){
        Assert-NoReparsePoint $WireGuardInstallerPath
        $package=Join-Path $managedRoot 'wireguard.msi';Copy-Item -LiteralPath $WireGuardInstallerPath -Destination $package;Private-Acl $package
        if((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ine $WireGuardInstallerSHA256){Stop-Worker 'WireGuard MSI changed while staging.'}
        $process=Start-Process -FilePath "$env:WINDIR\System32\msiexec.exe" -ArgumentList @('/i',('"'+$package+'"'),'/qn','/norestart') -Wait -PassThru
        if($process.ExitCode -notin @(0,3010) -or -not(Test-Path -LiteralPath $wg)){Stop-Worker 'WireGuard installation did not complete.'}
    }
    $stagedBinary=Join-Path $managedRoot 'zt-agent.exe'
    if(-not(Test-Path -LiteralPath $stagedBinary)) {New-Item -Path $stagedBinary -ItemType File | Out-Null;Private-Acl $stagedBinary}
    [IO.File]::WriteAllBytes($stagedBinary,$binary);Private-Acl $stagedBinary
    if((Get-FileHash -LiteralPath $stagedBinary -Algorithm SHA256).Hash -ine $AgentSHA256){Stop-Worker 'Agent changed while staging.'}
    if(-not$state){
        $state=[pscustomobject][ordered]@{
            version=1
            kind='zt-worker-automation'
            phase='preparing'
            invite_fingerprint=$fingerprint
            agent_sha256=$AgentSHA256.ToLowerInvariant()
            identity_fingerprint=''
            assignment=$null
            configured_hash=''
            checks=$null
            verification=$null
            worker_wireguard_public_key=''
            registration_url=''
            trusted_origin=''
            managed=[ordered]@{}
            owned_services=[ordered]@{}
            owned_rules=@()
            uninstalled_status=$null
            cleanup_receipt=$null
        }
        Save-State $state
    }
    if((Get-EntryValue $state 'phase') -eq 'rollback_needs_review'){Stop-Worker 'Previous rollback requires console review.'}
    $privatePath=Join-Path $managedRoot 'wireguard.private';$tokenPath=Join-Path $managedRoot 'node.token'
    $savedId = Get-EntryValue $state 'identity_fingerprint'
    if($savedId -and (-not(Test-Path -LiteralPath $privatePath) -or -not(Test-Path -LiteralPath $tokenPath))){Stop-Worker 'Saved identity is missing; restore it instead of generating replacements.'}
    if(-not(Test-Path -LiteralPath $privatePath)){$private=(& $wg genkey 2>$null | Out-String).Trim();if($LASTEXITCODE -ne 0){Stop-Worker 'WireGuard key generation failed.'};Write-Private $privatePath ($private+"`n")}
    $private=(Get-Content -LiteralPath $privatePath -Raw).Trim()
    $public=($private | & $wg pubkey 2>$null | Out-String).Trim();if($LASTEXITCODE -ne 0){Stop-Worker 'WireGuard public key derivation failed.'}
    Set-EntryValue $state 'worker_wireguard_public_key' $public
    Set-EntryValue $state 'registration_url' $invite.registration_url
    $regUri=[Uri]$invite.registration_url
    Set-EntryValue $state 'trusted_origin' "$($regUri.Scheme)://$($regUri.Authority)"
    if(-not(Test-Path -LiteralPath $tokenPath)){$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$random=New-Object byte[] 48;$rng.GetBytes($random);$token=[Convert]::ToBase64String($random).TrimEnd('=').Replace('+','-').Replace('/','_')}finally{$rng.Dispose()};Write-Private $tokenPath ($token+"`n")}
    $nodeToken=(Get-Content -LiteralPath $tokenPath -Raw).Trim()
    if($savedId -and -not(Test-Path -LiteralPath $hostKey)){Stop-Worker 'Saved SSH host identity is missing; restore it instead of generating replacements.'}
    if(-not(Test-Path -LiteralPath $hostKey)){& $keygen -A *> $null;if($LASTEXITCODE -ne 0){Stop-Worker 'Host key generation failed.'}}
    Assert-TrustedManagedPath $hostKey
    $hostPublic=Ssh-Public ((& $keygen -y -f $hostKey 2>$null | Out-String).Trim());if($LASTEXITCODE -ne 0){Stop-Worker 'Existing SSH host key could not be read.'}
    $payload=[ordered]@{invitation_id=$invite.invitation_id;wireguard_public_key=$public;ssh_host_public_key=$hostPublic;node_token=$nodeToken}
    $identity=Hash-Text ($payload | ConvertTo-Json -Compress)
    if($savedId -and $savedId -cne $identity){Stop-Worker 'Saved Worker identity changed; refusing registration.'}
    Set-EntryValue $state 'identity_fingerprint' $identity;Save-State $state
    $assignment=Wait-Claim $invite $payload $false
    if((Get-EntryValue $state 'phase') -eq 'complete'){
        $local=Check-Local $assignment
        if((Local-Ok $local) -and $assignment.verification.peer_applied -and $assignment.verification.heartbeat_recent -and $assignment.verification.ssh_authenticated){[ordered]@{ok=$true;already_installed=$true;node_name=$invite.node_name;node_ip=$assignment.node_ip;checks=$local;gateway_verification=$assignment.verification} | ConvertTo-Json -Depth 7;exit 0}
    }
    Set-EntryValue $state 'assignment' $assignment
    Set-EntryValue $state 'phase' 'enrolled'
    Save-State $state
    $networkStarted=$false
    try{
        $user=Get-LocalUser -Name $invite.ssh_username -ErrorAction SilentlyContinue
        if(-not$user){
            $rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$bytes=New-Object byte[] 48;$rng.GetBytes($bytes);$randomPassword=[Convert]::ToBase64String($bytes)+'!aA1'}finally{$rng.Dispose()}
            $secure=ConvertTo-SecureString -String $randomPassword -AsPlainText -Force
            New-LocalUser -Name $invite.ssh_username -Password $secure -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
        }
        $tunnelPath=Join-Path $managedRoot 'zt-worker.conf'
        Write-Private $tunnelPath ("[Interface]`nPrivateKey = $private`nAddress = $($assignment.node_ip)/32`n`n[Peer]`nPublicKey = $($invite.wireguard_public_key)`nEndpoint = $($invite.wireguard_endpoint)`nAllowedIPs = $($invite.gateway_vpn_ip)/32`nPersistentKeepalive = 25`n")
        $bastionPath=Join-Path $managedRoot 'bastion_id_ed25519.pub';Write-Private $bastionPath ((Ssh-Public $invite.bastion_public_key)+"`n")
        if(Test-Path -LiteralPath $workerStatePath){
            $cfgHash = Get-EntryValue $state 'configured_hash'
            if($cfgHash -and (Get-FileHash -LiteralPath (Join-Path $env:ProgramData 'ssh\sshd_config') -Algorithm SHA256).Hash -ine $cfgHash){Stop-Worker 'SSH configuration changed outside the installer; preserve it for review.'}
            [void](Invoke-TrustedScript (Join-Path $repo 'deploy\windows\restore-worker.ps1') @())
        }
        # Persist ownership before setup so a partially installed tunnel can be restored.
        $managedOwnership = [ordered]@{
            (Join-Path $env:ProgramData 'ssh\sshd_config') = [ordered]@{
                backup = Join-Path $env:ProgramData 'ZT-ServerOps\worker\sshd_config.before-zt'
                before_hash = if (Test-Path -LiteralPath (Join-Path $env:ProgramData 'ssh\sshd_config')) { (Get-FileHash -LiteralPath (Join-Path $env:ProgramData 'ssh\sshd_config') -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
            }
            (Join-Path $env:ProgramData 'ZT-ServerOps\agent\zt-agent.exe') = [ordered]@{
                before_hash = $null
                expected_hash = $AgentSHA256.ToLowerInvariant()
                after_hash = $AgentSHA256.ToLowerInvariant()
            }
            (Join-Path $env:ProgramData 'ZT-ServerOps\agent\config.json') = [ordered]@{
                before_hash = $null
            }
            (Join-Path $env:ProgramData 'ZT-ServerOps\worker\zt-worker.conf') = [ordered]@{
                before_hash = $null
            }
            (Join-Path $env:ProgramData 'ZT-ServerOps\worker\authorized_keys') = [ordered]@{
                before_hash = $null
            }
            (Join-Path $env:ProgramData 'ZT-ServerOps\worker\ssh_host_ed25519_key.pub') = [ordered]@{
                before_hash = $null
            }
        }
        Set-EntryValue $state 'managed' $managedOwnership
        $agentExePath = Join-Path $env:ProgramData 'ZT-ServerOps\agent\zt-agent.exe'
        $agentCfgPath = Join-Path $env:ProgramData 'ZT-ServerOps\agent\config.json'
        $expectedAgentCmd = '"' + $agentExePath + '" --service --config "' + $agentCfgPath + '"'
        $ownedServicesObj = [ordered]@{
            agent = [ordered]@{
                name = 'ZTServerOpsAgent'
                command = $expectedAgentCmd
            }
            tunnel = [ordered]@{
                name = 'WireGuardTunnel$zt-worker'
                config = Join-Path $env:ProgramData 'ZT-ServerOps\worker\zt-worker.conf'
            }
        }
        Set-EntryValue $state 'owned_services' $ownedServicesObj
        Set-EntryValue $state 'owned_rules' @('ZT-ServerOps-SSH-VPN', 'ZT-ServerOps-SSH-Transport-Block')
        Set-EntryValue $state 'phase' 'network_in_progress'
        Save-State $state
        $networkStarted=$true
        # Invoke in the same scope so a real adapter array reaches the existing script.
        & (Join-Path $repo 'deploy\windows\setup-worker.ps1') -TunnelConfigPath $tunnelPath -GatewaySshPublicKeyPath $bastionPath -TransportInterfaceAlias $TransportInterfaceAlias -VpnAddress $assignment.node_ip -GatewayVpnAddress $invite.gateway_vpn_ip -SshUser $invite.ssh_username -DedicatedVm *> $null
        $configuredHash = (Get-FileHash -LiteralPath (Join-Path $env:ProgramData 'ssh\sshd_config') -Algorithm SHA256).Hash.ToLowerInvariant()
        Set-EntryValue $state 'configured_hash' $configuredHash
        $state.managed[(Join-Path $env:ProgramData 'ssh\sshd_config')].after_hash = $configuredHash
        $workerConfPath = Join-Path $env:ProgramData 'ZT-ServerOps\worker\zt-worker.conf'
        if (Test-Path -LiteralPath $workerConfPath) {
            $state.managed[$workerConfPath].after_hash = (Get-FileHash -LiteralPath $workerConfPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $authKeysPath = Join-Path $env:ProgramData 'ZT-ServerOps\worker\authorized_keys'
        if (Test-Path -LiteralPath $authKeysPath) {
            $state.managed[$authKeysPath].after_hash = (Get-FileHash -LiteralPath $authKeysPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $hostPubPath = Join-Path $env:ProgramData 'ZT-ServerOps\worker\ssh_host_ed25519_key.pub'
        if (Test-Path -LiteralPath $hostPubPath) {
            $state.managed[$hostPubPath].after_hash = (Get-FileHash -LiteralPath $hostPubPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        Set-EntryValue $state 'phase' 'network_active'
        Save-State $state
        $configPath=Join-Path $managedRoot 'agent-config.json'
        $config=[ordered]@{GATEWAY_URL='http://10.100.0.1:3000';NODE_ID=$invite.node_name;NODE_TOKEN=$nodeToken;NETWORK_INTERFACE='zt-worker';DISK_MOUNT_POINT='C:\';BEACON_INTERVAL_SECONDS='3.0';MAX_BACKOFF_SECONDS='30.0';HTTP_TIMEOUT_SECONDS='3.0';JITTER_RATIO='0.0'}
        Write-Private $configPath ($config | ConvertTo-Json)
        [void](Invoke-TrustedScript (Join-Path $repo 'agent\install-windows.ps1') @('-BinaryPath',$stagedBinary,'-ConfigPath',$configPath,'-ValidateOnly'))
        [void](Invoke-TrustedScript (Join-Path $repo 'agent\install-windows.ps1') @('-BinaryPath',$stagedBinary,'-ConfigPath',$configPath))
        $state.managed[$agentCfgPath].after_hash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Set-EntryValue $state 'phase' 'agent_active'
        Save-State $state
        $localReport=Invoke-TrustedScript (Join-Path $repo 'deploy\windows\check-worker.ps1') @()
        $verified=Wait-Claim $invite $payload $true
        $local=Check-Local $verified
        if(-not(Local-Ok $local)){Stop-Worker 'VPN/Agent/SSH local checks did not complete.'}
        Set-EntryValue $state 'phase' 'complete'
        Set-EntryValue $state 'assignment' $verified
        Set-EntryValue $state 'checks' $local
        Set-EntryValue $state 'verification' $verified.verification
        Save-State $state
        [ordered]@{ok=$true;node_name=$invite.node_name;node_ip=$verified.node_ip;checks=$local;gateway_verification=$verified.verification;still_required=@('Independent Internet firewall probe','Reboot verification')} | ConvertTo-Json -Depth 8
    }catch{
        if($networkStarted){
            Stop-Service -Name $agentServiceName -ErrorAction SilentlyContinue
            try{if(Test-Path -LiteralPath $workerStatePath){[void](Invoke-TrustedScript (Join-Path $repo 'deploy\windows\restore-worker.ps1') @())};Set-EntryValue $state 'phase' 'rolled_back'}
            catch{Set-EntryValue $state 'phase' 'rollback_needs_review'}
            Save-State $state
        }
        throw
    }
}catch{
    $message=if($_.Exception.Message.StartsWith('ZT: ')){$_.Exception.Message.Substring(4)}else{'Worker operation stopped; inspect prerequisites and protected state. No secret was printed.'}
    [Console]::Error.WriteLine(([ordered]@{ok=$false;error=$message;state_file=$statePath} | ConvertTo-Json -Depth 3))
    exit 1
}finally{if($lockHandle){$lockHandle.Dispose()}}
