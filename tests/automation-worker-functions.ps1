#Requires -Version 5.1
<# Parser and pure/HTTPS tests only. Does not execute Worker installation or Windows services. #>
[CmdletBinding()]
param([string]$FixturePath,[string]$ResultPath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=Split-Path -Parent $PSScriptRoot
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'deploy/automation/worker.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Worker PowerShell script has syntax errors.'}
$definitions=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
foreach($definition in $definitions){Invoke-Expression $definition.Extent.Text}
. (Join-Path $root 'deploy/windows/worker-common.ps1')
$checks=New-Object Collections.Generic.List[string]
function Passed([string]$Name){$checks.Add($Name)}
function Expect-Failure([scriptblock]$Operation,[string]$Name){
    $failed=$false
    try{& $Operation | Out-Null}catch{$failed=$true}
    if(-not$failed){throw ('Expected validation failure: '+$Name)}
    Passed $Name
}
function Copy-Data($Value){return ($Value | ConvertTo-Json -Depth 10 | ConvertFrom-Json)}
function Fake-Invite {
    $bytes=New-Object byte[] 32
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
    $hash=[Security.Cryptography.SHA256]::Create()
    try{$gateway='sha256:'+([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
    $sshBytes=[byte[]](0,0,0,11,115,115,104,45,101,100,50,53,53,49,57,0,0,0,32)+$bytes
    return [pscustomobject][ordered]@{version=1;gateway_id=$gateway;registration_url='https://gateway.example/api/enrollment/claim';wireguard_endpoint='192.0.2.10:51820';wireguard_public_key=[Convert]::ToBase64String($bytes);gateway_vpn_ip='10.100.0.1';bastion_public_key=('ssh-ed25519 '+[Convert]::ToBase64String($sshBytes));invitation_id=[Guid]::NewGuid().ToString();join_token=('x'*64);expires_at=[DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o');node_name='test-windows-01';node_type='VM';worker_os='windows';ssh_username='ztuser'}
}
function Fake-Reply($Invite){
    $reply=[ordered]@{version=1;status='READY';peer_ready=$true;node_id=[Guid]::NewGuid().ToString();node_ip='10.100.0.3';gateway_api_url='http://10.100.0.1:3000';verification=[pscustomobject]@{peer_applied=$true;heartbeat_recent=$false;ssh_authenticated=$false}}
    foreach($field in @('gateway_id','invitation_id','registration_url','node_name','node_type','worker_os','ssh_username','gateway_vpn_ip','wireguard_endpoint','wireguard_public_key','bastion_public_key')){$reply[$field]=$Invite.$field}
    return [pscustomobject]$reply
}
Passed 'Parser accepted Worker script'
$binary=New-Object byte[] 128
$binary[0]=77;$binary[1]=90;$binary[60]=64;$binary[64]=80;$binary[65]=69;$binary[68]=0x64;$binary[69]=0x86
Check-WindowsBinary $binary 'AMD64';Passed 'PE64 Agent architecture matches host'
Expect-Failure {Check-WindowsBinary $binary 'ARM64'} 'Wrong Agent architecture rejected'
$binary[68]=0x4c;$binary[69]=0x01
Expect-Failure {Check-WindowsBinary $binary 'AMD64'} 'PE32 Agent rejected'
$binary[60]=250
Expect-Failure {Check-WindowsBinary $binary 'AMD64'} 'Malformed PE header rejected'
$invite=Fake-Invite
$fingerprint=Check-Invitation $invite $false
if($fingerprint -notmatch '^[a-f0-9]{64}$'){throw 'Invitation fingerprint was not produced.'}
Passed 'Valid invitation and fingerprint'
$bad=Copy-Data $invite;$bad.version=$true
Expect-Failure {Check-Invitation $bad $false} 'Boolean version rejected'
$bad=Copy-Data $invite;$bad.gateway_id='sha256:'+('0'*64)
Expect-Failure {Check-Invitation $bad $false} 'Gateway public identity mismatch rejected'
$bad=Copy-Data $invite;$bad.registration_url='http://gateway.example/api/enrollment/claim'
Expect-Failure {Check-Invitation $bad $false} 'Plaintext enrollment URL rejected'
$bad=Copy-Data $invite;$bad.registration_url='https://gateway.example/api/enrollment/claim?secret=ignored'
Expect-Failure {Check-Invitation $bad $false} 'Query credentials rejected'
$bad=Copy-Data $invite;$bad.expires_at='2000-01-01T00:00:00Z'
Expect-Failure {Check-Invitation $bad $false} 'Expired fresh invitation rejected'
[void](Check-Invitation $bad $true);Passed 'Expired invitation allowed only for a saved-identity retry'
$bad=Copy-Data $invite;$bad.ssh_username='administrator'
Expect-Failure {Check-Invitation $bad $false} 'Privileged SSH account rejected'
$reply=Fake-Reply $invite
[void](Validate-Assignment $reply $invite);Passed 'Valid response assignment'
$reply.registration_url='https://other.example/api/enrollment/claim'
Expect-Failure {Validate-Assignment $reply $invite} 'Response registration URL is pinned'
$reply=Fake-Reply $invite;$reply.node_ip='10.100.0.1'
Expect-Failure {Validate-Assignment $reply $invite} 'Reserved Gateway address rejected'
$reply=Fake-Reply $invite;$reply.peer_ready=$false
Expect-Failure {Validate-Assignment $reply $invite} 'Pending acknowledgement cannot masquerade as ready'
if($FixturePath){
    $fixture=Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    $CaFile=$fixture.ca_file
    $payload=$fixture.payload
    $response=Invoke-Claim $fixture.success $payload
    if(-not$response.peer_ready){throw 'Real HTTPS success did not return a ready peer.'}
    Passed 'Actual HTTPS with compiled private-CA delegate'
    $delegate=New-PinnedCaValidator $CaFile
    if($delegate.Callback.GetType().FullName -ne 'System.Net.Security.RemoteCertificateValidationCallback'){throw 'Certificate validator is not a compiled .NET delegate.'}
    Passed 'Certificate callback has no PowerShell runspace dependency'
    $CaFile=$null
    Expect-Failure {Invoke-Claim $fixture.success $payload} 'Actual HTTPS rejects untrusted CA'
    $CaFile=$fixture.wrong_ca_file
    Expect-Failure {Invoke-Claim $fixture.success $payload} 'Actual HTTPS rejects a different pinned CA'
    $CaFile=$fixture.ca_file
    Expect-Failure {Invoke-Claim $fixture.hostname_mismatch $payload} 'Actual HTTPS rejects hostname mismatch'
    Expect-Failure {Invoke-Claim $fixture.redirect $payload} 'Actual HTTPS refuses redirects'
    Expect-Failure {Invoke-Claim $fixture.used $payload} 'Actual HTTPS handles consumed-code conflict'
    if($fixture.PSObject.Properties.Name -contains 'expired'){
        $CaFile=$fixture.expired_ca_file
        Expect-Failure {Invoke-Claim $fixture.expired $payload} 'Actual HTTPS rejects expired certificate'
    }
}
$uninstallTest = Join-Path $PSScriptRoot 'windows-worker-uninstall-functions.ps1'
if (Test-Path -LiteralPath $uninstallTest) {
    & $uninstallTest | Out-Null
    Passed 'Windows Worker uninstaller functions and tests passed'
}
$result=[ordered]@{ok=$true;scope='PowerShell parser/pure validation and optional real local HTTPS; NOT Windows installation/service/firewall runtime';checks=$checks.ToArray();check_count=$checks.Count}
$json=$result | ConvertTo-Json -Depth 4
if($ResultPath){[IO.File]::WriteAllText($ResultPath,$json,(New-Object Text.UTF8Encoding($false)))}
$json
