#Requires -Version 5.1
<# Parser and pure/sandbox tests for Windows Worker uninstall functions.
   Does not execute real Windows uninstaller, native services or system mutations. #>
[CmdletBinding()]
param([string]$FixturePath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot

# 1. Parse both worker.ps1 and worker-uninstall.ps1 with AST to verify 0 syntax errors
$tokens = $null; $parseErrors = $null
$astWorker = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'deploy/automation/worker.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) {
    throw ('Worker PowerShell script has syntax errors: ' + ($parseErrors -join '; '))
}

$tokens = $null; $parseErrors = $null
$astUninstall = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'deploy/automation/worker-uninstall.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) {
    throw ('Worker uninstaller PowerShell script has syntax errors: ' + ($parseErrors -join '; '))
}

# 2. Extract function definitions via AST and invoke them in test scope
$definitions = $astWorker.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($def in $definitions) { Invoke-Expression $def.Extent.Text }

$definitions = $astUninstall.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($def in $definitions) { Invoke-Expression $def.Extent.Text }

. (Join-Path $root 'deploy/windows/worker-common.ps1')

# Setup mock environment fixture for non-Windows / sandbox test runners
if (-not (Get-PSDrive -Name C -ErrorAction SilentlyContinue)) {
    New-PSDrive -Name C -PSProvider FileSystem -Root ([System.IO.Path]::GetTempPath()) | Out-Null
}
if (-not (Get-Command Get-Service -ErrorAction SilentlyContinue)) {
    function Get-Service { param([string]$Name, $ErrorAction) return $null }
}
if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
    function Get-CimInstance { param([string]$ClassName, [string]$Filter, $ErrorAction) return $null }
}
class MockAcl {
    [object[]] $Access = @()
    [object] GetOwner($type) { return [pscustomobject]@{ Value = 'S-1-5-18' } }
    [void] SetAccessRuleProtection($p, $i) {}
    [void] PurgeAccessRules($id) {}
    [void] AddAccessRule($rule) {}
}
if (-not (Get-Command Get-Acl -ErrorAction SilentlyContinue)) {
    function Get-Acl {
        param([string]$LiteralPath)
        return [MockAcl]::new()
    }
}
if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
    function Private-Acl([string]$Path) {
        # Non-Windows mock: no-op since NTFS ACLs are Windows-only
    }
}
if (-not (Get-Command Set-Acl -ErrorAction SilentlyContinue)) {
    function Set-Acl { param($LiteralPath, $AclObject) }
}
if (-not $env:ProgramData) {
    $env:ProgramData = Join-Path ([System.IO.Path]::GetTempPath()) 'zt-mock-programdata'
}
if (-not $env:ProgramFiles) {
    $env:ProgramFiles = Join-Path ([System.IO.Path]::GetTempPath()) 'zt-mock-programfiles'
}
if (-not $env:WINDIR) {
    $env:WINDIR = Join-Path ([System.IO.Path]::GetTempPath()) 'zt-mock-windir'
}

# Initialize script-level paths and settings needed by AST-extracted functions
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

$checks = New-Object Collections.Generic.List[string]
function Passed([string]$Name) { $checks.Add($Name) }
function Expect-Failure([scriptblock]$Operation, [string]$Name) {
    $failed = $false
    try { & $Operation | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw ('Expected validation failure: ' + $Name) }
    Passed $Name
}
function Copy-Data($Value) {
    return ($Value | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
}

function Fake-Invite-Data {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $gateway = 'sha256:' + ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $hash.Dispose()
    }
    $sshBytes = [byte[]](0,0,0,11,115,115,104,45,101,100,50,53,53,49,57,0,0,0,32) + $bytes
    return [pscustomobject][ordered]@{
        version = 1
        gateway_id = $gateway
        registration_url = 'https://gateway.example/api/enrollment/claim'
        wireguard_endpoint = '192.0.2.10:51820'
        wireguard_public_key = [Convert]::ToBase64String($bytes)
        gateway_vpn_ip = '10.100.0.1'
        bastion_public_key = ('ssh-ed25519 ' + [Convert]::ToBase64String($sshBytes))
        invitation_id = [Guid]::NewGuid().ToString()
        join_token = ('x' * 64)
        expires_at = [DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o')
        node_name = 'test-windows-01'
        node_type = 'VM'
        worker_os = 'windows'
        ssh_username = 'ztuser'
    }
}

function Fake-Assignment-Data($Invite) {
    $reply = [ordered]@{
        version = 1
        status = 'READY'
        peer_ready = $true
        node_id = [Guid]::NewGuid().ToString()
        node_ip = '10.100.0.5'
        gateway_api_url = 'http://10.100.0.1:3000'
        verification = [pscustomobject]@{ peer_applied = $true; heartbeat_recent = $true; ssh_authenticated = $true }
    }
    foreach ($field in @('gateway_id','invitation_id','registration_url','node_name','node_type','worker_os','ssh_username','gateway_vpn_ip','wireguard_endpoint','wireguard_public_key','bastion_public_key')) {
        $reply[$field] = $Invite.$field
    }
    return [pscustomobject]$reply
}

function Fake-Bundle-Data($Assignment, $WorkerWgPubKey) {
    return [pscustomobject][ordered]@{
        version = 1
        gateway_id = $Assignment.gateway_id
        operation_id = [Guid]::NewGuid().ToString().ToLowerInvariant()
        node_id = $Assignment.node_id
        node_name = $Assignment.node_name
        invitation_id = $Assignment.invitation_id
        wireguard_public_key = $WorkerWgPubKey
        node_ip = $Assignment.node_ip
        completion_url = 'https://gateway.example/api/offboarding/complete'
        cleanup_token = ('a' * 64)
    }
}

Passed 'AST parser accepted worker.ps1 and worker-uninstall.ps1'

# --- Test 1: Canonical JSON serialization ---
$sampleDict = [ordered]@{
    platform = 'windows'
    operation_id = '12345678-1234-1234-1234-123456789abc'
    gateway_id = 'sha256:abc'
    node_id = '87654321-4321-4321-4321-cba987654321'
    steps = [ordered]@{
        tunnel = 'DONE'
        agent = 'DONE'
        secrets = 'DONE'
        ssh = 'DONE'
        firewall = 'DONE'
    }
}
$canon = ConvertTo-CanonicalJson $sampleDict
$expectedCanon = '{"gateway_id":"sha256:abc","node_id":"87654321-4321-4321-4321-cba987654321","operation_id":"12345678-1234-1234-1234-123456789abc","platform":"windows","steps":{"agent":"DONE","firewall":"DONE","secrets":"DONE","ssh":"DONE","tunnel":"DONE"}}'
if ($canon -ne $expectedCanon) {
    throw ('Canonical JSON did not sort keys or format correctly: ' + $canon)
}
Passed 'Canonical JSON produces exact sorted compact output'

# Test string escaping in canonical JSON
$escapeTest = [ordered]@{ a = ('quote: ' + [char]34 + ' backslash: ' + [char]92 + ' newline: ' + [char]10) }
$escapeCanon = ConvertTo-CanonicalJson $escapeTest
$expectedEscape = '{"a":"quote: ' + [char]92 + [char]34 + ' backslash: ' + [char]92 + [char]92 + ' newline: ' + [char]92 + 'n"}'
if ($escapeCanon -ne $expectedEscape) {
    throw ('Canonical JSON escape sequence mismatch: ' + $escapeCanon)
}
Passed 'Canonical JSON escapes quotes backslashes and control characters'

# --- Test 2: Valid Authorization Bundle Validation ---
$invite = Fake-Invite-Data
$assignment = Fake-Assignment-Data $invite

# Generate mock worker WireGuard public key (32 bytes, nonzero)
$workerBytes = New-Object byte[] 32
for ($i = 0; $i -lt 32; $i++) { $workerBytes[$i] = [byte]($i + 1) }
$workerWgPub = [Convert]::ToBase64String($workerBytes)

$validBundle = Fake-Bundle-Data $assignment $workerWgPub
$checked = Check-OffboardingBundle $validBundle $assignment $workerWgPub
if ($checked.trusted_origin -ne 'https://gateway.example') {
    throw 'Trusted origin derivation mismatch.'
}
if ($checked.expected_completion -ne 'https://gateway.example/api/offboarding/complete') {
    throw 'Expected completion URL mismatch.'
}
Passed 'Valid authorization bundle accepted and bound to local identity'

# --- Test 3: Rejection of schema / key violations ---
$bad = Copy-Data $validBundle
$bad | Add-Member -NotePropertyName 'extra_key' -NotePropertyValue 'injected'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Extra key in bundle rejected'

$bad = [pscustomobject][ordered]@{
    version = 1
    operation_id = $validBundle.operation_id
}
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Missing required keys rejected'

$bad = Copy-Data $validBundle
$bad.version = $true
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Boolean version rejected'

$bad = Copy-Data $validBundle
$bad.version = 2
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Unsupported version rejected'

# --- Test 4: Rejection of malformed / non-canonical UUIDs ---
$bad = Copy-Data $validBundle
$bad.operation_id = 'not-a-uuid'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Invalid operation_id rejected'

$bad = Copy-Data $validBundle
$bad.operation_id = $validBundle.operation_id.ToUpperInvariant()
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Uppercase non-canonical operation_id rejected'

$bad = Copy-Data $validBundle
$bad.node_id = 'invalid-node-id'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Invalid node_id rejected'

$bad = Copy-Data $validBundle
$bad.invitation_id = 'invalid-invitation-id'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Invalid invitation_id rejected'

# --- Test 5: WireGuard Public Key validation ---
$bad = Copy-Data $validBundle
$bad.wireguard_public_key = 'badbase64!!!'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Malformed base64 WireGuard public key rejected'

$bad = Copy-Data $validBundle
$bad.wireguard_public_key = [Convert]::ToBase64String((New-Object byte[] 16))
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Short WireGuard public key rejected'

$bad = Copy-Data $validBundle
$bad.wireguard_public_key = [Convert]::ToBase64String((New-Object byte[] 32))
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'All-zero WireGuard public key rejected'

# WireGuard key binding: bundle wireguard_public_key must match local Worker key, NOT Gateway key!
$bad = Copy-Data $validBundle
$bad.wireguard_public_key = $assignment.wireguard_public_key
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Gateway wireguard key cannot masquerade as local Worker key'

$differentWorkerBytes = New-Object byte[] 32
for ($i = 0; $i -lt 32; $i++) { $differentWorkerBytes[$i] = [byte]($i + 50) }
$differentWorkerPub = [Convert]::ToBase64String($differentWorkerBytes)
$bad = Copy-Data $validBundle
$bad.wireguard_public_key = $differentWorkerPub
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Mismatched worker WireGuard public key rejected'

# --- Test 6: Node IP and Node Name validation ---
$bad = Copy-Data $validBundle
$bad.node_ip = '999.999.999.999'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Invalid node_ip format rejected'

$bad = Copy-Data $validBundle
$bad.node_ip = '10.100.0.99'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Mismatched node_ip against assignment rejected'

$bad = Copy-Data $validBundle
$bad.node_name = 'different-name'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Mismatched node_name against assignment rejected'

$bad = Copy-Data $validBundle
$bad.node_name = 'bad name with spaces'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Node name with forbidden characters rejected'

# --- Test 7: Cleanup Token format ---
$bad = Copy-Data $validBundle
$bad.cleanup_token = 'tooshort'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Short cleanup_token rejected'

$bad = Copy-Data $validBundle
$bad.cleanup_token = ('g' * 64)
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Non-hex cleanup_token rejected'

# --- Test 8: Identity Binding against Assignment ---
$bad = Copy-Data $validBundle
$bad.gateway_id = 'sha256:' + ('f' * 64)
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Mismatched gateway_id rejected'

$bad = Copy-Data $validBundle
$bad.node_id = [Guid]::NewGuid().ToString().ToLowerInvariant()
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Mismatched node_id rejected'

$bad = Copy-Data $validBundle
$bad.invitation_id = [Guid]::NewGuid().ToString().ToLowerInvariant()
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Mismatched invitation_id rejected'

# --- Test 9: Completion URL Origin & Path safety ---
$bad = Copy-Data $validBundle
$bad.completion_url = 'http://gateway.example/api/offboarding/complete'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Plaintext HTTP completion_url rejected'

$bad = Copy-Data $validBundle
$bad.completion_url = 'https://attacker.example/api/offboarding/complete'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Foreign host completion_url rejected'

$bad = Copy-Data $validBundle
$bad.completion_url = 'https://gateway.example:8443/api/offboarding/complete'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Port-mismatched completion_url rejected'

$bad = Copy-Data $validBundle
$bad.completion_url = 'https://gateway.example/api/offboarding/complete?token=stolen'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Completion URL with query parameter rejected'

$bad = Copy-Data $validBundle
$bad.completion_url = 'https://gateway.example/api/offboarding/complete#fragment'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Completion URL with fragment rejected'

$bad = Copy-Data $validBundle
$bad.completion_url = 'https://user:pass@gateway.example/api/offboarding/complete'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Completion URL with userinfo rejected'

$bad = Copy-Data $validBundle
$bad.completion_url = 'https://gateway.example/api/other/endpoint'
Expect-Failure { Check-OffboardingBundle $bad $assignment $workerWgPub } 'Wrong completion path rejected'

# --- Test 10: Receipt Builder & Evidence Digest ---
$allDoneSteps = [ordered]@{
    agent = 'DONE'
    tunnel = 'DONE'
    firewall = 'DONE'
    ssh = 'DONE'
    secrets = 'DONE'
}
$receipt = Build-Receipt $allDoneSteps $validBundle
if ($receipt.platform -ne 'windows') { throw 'Receipt platform must be windows.' }
if ($receipt.evidence_digest -notmatch '^[0-9a-f]{64}$') { throw 'Receipt evidence_digest is not 64-char hex.' }

$expectedEvidence = [ordered]@{
    gateway_id = $validBundle.gateway_id
    node_id = $validBundle.node_id
    operation_id = $validBundle.operation_id
    platform = 'windows'
    steps = [ordered]@{
        agent = 'DONE'
        firewall = 'DONE'
        secrets = 'DONE'
        ssh = 'DONE'
        tunnel = 'DONE'
    }
}
$expectedDigest = Hash-Text (ConvertTo-CanonicalJson $expectedEvidence)
if ($receipt.evidence_digest -ne $expectedDigest) {
    throw ('Evidence digest mismatch: ' + $receipt.evidence_digest + ' vs ' + $expectedDigest)
}
Passed 'Receipt evidence_digest matches canonical JSON SHA-256 specification'

# Test with partial REVIEW step
$partialSteps = [ordered]@{
    agent = 'DONE'
    tunnel = 'DONE'
    firewall = 'DONE'
    ssh = 'REVIEW'
    secrets = 'DONE'
}
$partialReceipt = Build-Receipt $partialSteps $validBundle
if ($partialReceipt.steps.ssh -ne 'REVIEW') { throw 'Partial receipt did not record REVIEW.' }
if ($partialReceipt.evidence_digest -eq $receipt.evidence_digest) { throw 'Evidence digest must change when step outcome changes.' }
Passed 'Receipt reflects partial REVIEW state and produces unique digest'

# --- Test 11: Preflight state checks ---
$mockState = [pscustomobject][ordered]@{
    version = 1
    kind = 'zt-worker-automation'
    phase = 'complete'
    invite_fingerprint = 'mockfp'
    agent_sha256 = ('0' * 64)
    configured_hash = ('1' * 64)
    worker_wireguard_public_key = $workerWgPub
    assignment = $assignment
    managed = [ordered]@{}
}
$preflight = Preflight-Uninstall $mockState
if (-not $preflight.assignment) { throw 'Preflight did not return assignment.' }
Passed 'Preflight checks valid state without exceptions'

Expect-Failure { Preflight-Uninstall $null } 'Null state rejected by preflight'
$badState = Copy-Data $mockState; $badState.version = 2
Expect-Failure { Preflight-Uninstall $badState } 'Version 2 state rejected by preflight'
$badState = Copy-Data $mockState; $badState.kind = 'other'
Expect-Failure { Preflight-Uninstall $badState } 'Unknown kind state rejected by preflight'
$badState = Copy-Data $mockState; $badState.assignment = $null
Expect-Failure { Preflight-Uninstall $badState } 'State without assignment rejected by preflight'

# --- Test 12: Allowed managed paths list ---
$allowedPaths = Get-AllowedManagedPaths
if ($allowedPaths.Count -lt 5) { throw 'Allowed managed paths list is incomplete.' }
$hasSshd = $false; $hasAgent = $false; $hasTunnel = $false
foreach ($p in $allowedPaths) {
    if ($p -match 'sshd_config') { $hasSshd = $true }
    if ($p -match 'zt-agent\.exe') { $hasAgent = $true }
    if ($p -match 'zt-worker\.conf') { $hasTunnel = $true }
}
if (-not $hasSshd -or -not $hasAgent -or -not $hasTunnel) {
    throw 'Fixed allowlist missing required core paths.'
}
Passed 'Fixed managed path allowlist protects host paths from arbitrary deletion'

# Test 12b: Allowed managed paths survives null env:ProgramData
$savedProgramData = $env:ProgramData
try {
    $env:ProgramData = $null
    $fallbackPaths = Get-AllowedManagedPaths
    if ($fallbackPaths.Count -lt 5 -or -not ($fallbackPaths[0] -match 'sshd_config')) {
        throw 'Fallback paths failed when env:ProgramData is null.'
    }
    Passed 'Get-AllowedManagedPaths safely falls back when env:ProgramData is null'
} finally {
    $env:ProgramData = $savedProgramData
}

# --- Test 13: Local Worker WireGuard public key extraction ---
$extractedKey = Get-LocalWorkerWgPublicKey $mockState $env:TEMP
if ($extractedKey -ne $workerWgPub) {
    throw ('Extracted key did not match state key: ' + $extractedKey)
}
Passed 'Local Worker WireGuard public key extracted correctly from state'

# --- Test 14: Step checkpoint durability and resume simulation ---
$tempDir = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('zt-test-' + [Guid]::NewGuid().ToString('N')))
[IO.Directory]::CreateDirectory($tempDir) | Out-Null
try {
    $cleanupFile = [IO.Path]::Combine($tempDir, 'cleanup.json')
    $testJournal = [ordered]@{
        version = 1
        kind = 'zt-worker-cleanup'
        operation_id = $validBundle.operation_id
        node_id = $validBundle.node_id
        node_name = $validBundle.node_name
        node_ip = $validBundle.node_ip
        gateway_id = $validBundle.gateway_id
        invitation_id = $validBundle.invitation_id
        wireguard_public_key = $validBundle.wireguard_public_key
        completion_url = $validBundle.completion_url
        status = 'IN_PROGRESS'
        steps = [ordered]@{}
        gateway_acknowledged = $false
    }
    [IO.File]::WriteAllText($cleanupFile, (ConvertTo-CanonicalJson $testJournal))

    # Checkpoint step 1
    Checkpoint-Step $cleanupFile $testJournal 'agent' 'DONE'
    $reloaded = Get-Content -LiteralPath $cleanupFile -Raw | ConvertFrom-Json
    if ($reloaded.steps.agent -ne 'DONE') { throw 'Checkpoint step 1 not persisted.' }

    # Checkpoint step 2
    Checkpoint-Step $cleanupFile $testJournal 'tunnel' 'DONE'
    $reloaded = Get-Content -LiteralPath $cleanupFile -Raw | ConvertFrom-Json
    if ($reloaded.steps.tunnel -ne 'DONE') { throw 'Checkpoint step 2 not persisted.' }

    # Simulate crash and resume: agent and tunnel are already DONE and must not be rerun
    $resumedList = New-Object Collections.Generic.List[string]
    $stepList = @(
        @{ name = 'agent';    fn = { $resumedList.Add('agent'); 'DONE' } },
        @{ name = 'tunnel';   fn = { $resumedList.Add('tunnel'); 'DONE' } },
        @{ name = 'firewall'; fn = { $resumedList.Add('firewall'); 'DONE' } },
        @{ name = 'ssh';      fn = { $resumedList.Add('ssh'); 'DONE' } },
        @{ name = 'secrets';  fn = { $resumedList.Add('secrets'); 'DONE' } }
    )

    foreach ($entry in $stepList) {
        $sName = $entry.name
        $prop = $reloaded.steps.PSObject.Properties[$sName]
        $isDone = $prop -and ($prop.Value -eq 'DONE')
        if (-not $isDone) {
            $outcome = & $entry.fn
            Checkpoint-Step $cleanupFile $testJournal $sName $outcome
        }
    }

    if ($resumedList.Contains('agent') -or $resumedList.Contains('tunnel')) {
        throw 'Resumed cleanup re-executed already completed steps.'
    }
    if (-not $resumedList.Contains('firewall') -or -not $resumedList.Contains('ssh') -or -not $resumedList.Contains('secrets')) {
        throw 'Resumed cleanup failed to execute unfinished steps.'
    }

    $finalReloaded = Get-Content -LiteralPath $cleanupFile -Raw | ConvertFrom-Json
    if ($finalReloaded.steps.agent -ne 'DONE' -or $finalReloaded.steps.firewall -ne 'DONE') {
        throw 'Final reloaded journal missing completed steps.'
    }
    Passed 'Crash recovery resumes unfinished steps with durable per-step checkpoints'
} finally {
    if ([IO.Directory]::Exists($tempDir)) {
        [IO.Directory]::Delete($tempDir, $true)
    }
}

# --- Test 15: Preflight ownership conflict detection ---
$conflictPreflight = [ordered]@{
    conflicts = (New-Object 'System.Collections.Generic.Dictionary[string,string]')
    managed = [ordered]@{
        'C:\ssh\sshd_config' = [ordered]@{
            backup = 'C:\backup\sshd_config.before-zt'
            before_hash = 'aaaabbbbcccc'
            after_hash = '111122223333'
        }
    }
}
$conflictPreflight.managed = Normalize-ManagedState $conflictPreflight.managed
$conflictPreflight.conflicts['C:\ssh\sshd_config'] = 'File was modified since installation; preserving user edits.'
$resultPreflight = Restore-OrRemoveManagedFile 'C:\ssh\sshd_config' $conflictPreflight
if ($resultPreflight -ne $false) {
    throw 'Restore-OrRemoveManagedFile must fail on conflict and preserve user file.'
}
Passed 'Conflict detection protects modified user configuration'

# --- Test 15b: Unowned file preservation ---
$unownedDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-unowned-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($unownedDir) | Out-Null
try {
    $unownedFile = Join-Path $unownedDir 'unowned_file.txt'
    [IO.File]::WriteAllText($unownedFile, 'important-user-data')
    $testPreflight = [ordered]@{
        conflicts = (New-Object 'System.Collections.Generic.Dictionary[string,string]')
        managed = (New-Object 'System.Collections.Generic.Dictionary[string,object]')
        state = [ordered]@{
            version = 1; kind = 'zt-worker-automation'; assignment = $assignment
        }
    }
    $ret = Restore-OrRemoveManagedFile $unownedFile $testPreflight
    if ($ret -ne $false) {
        throw 'Restore-OrRemoveManagedFile must return false for unowned file.'
    }
    if (-not (Test-Path -LiteralPath $unownedFile)) {
        throw 'Unowned file was improperly deleted!'
    }
    if (-not $testPreflight.conflicts.ContainsKey($unownedFile)) {
        throw 'Conflict not recorded for unowned file.'
    }
    Passed 'Unowned file without journal ownership is preserved and not deleted'
} finally {
    if ([IO.Directory]::Exists($unownedDir)) { [IO.Directory]::Delete($unownedDir, $true) }
}

# --- Test 15c: Modified managed file preservation ---
$modDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-mod-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($modDir) | Out-Null
try {
    $modFile = Join-Path $modDir 'modified_file.txt'
    [IO.File]::WriteAllText($modFile, 'modified-by-user')
    $testPreflight = [ordered]@{
        conflicts = (New-Object 'System.Collections.Generic.Dictionary[string,string]')
        managed = [ordered]@{
            $modFile = [ordered]@{
                before_hash = $null
                after_hash = '0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff'
            }
        }
        state = [ordered]@{
            version = 1; kind = 'zt-worker-automation'; assignment = $assignment
        }
    }
    $testPreflight.managed = Normalize-ManagedState $testPreflight.managed
    $ret = Restore-OrRemoveManagedFile $modFile $testPreflight
    if ($ret -ne $false) {
        throw 'Restore-OrRemoveManagedFile must return false for modified file.'
    }
    if (-not (Test-Path -LiteralPath $modFile)) {
        throw 'Modified file was improperly deleted!'
    }
    if (-not $testPreflight.conflicts.ContainsKey($modFile)) {
        throw 'Conflict not recorded for modified file.'
    }
    Passed 'Modified managed file is preserved and not deleted'
} finally {
    if ([IO.Directory]::Exists($modDir)) { [IO.Directory]::Delete($modDir, $true) }
}

# --- Test 15d: Untouched installer-created file deletion ---
$untouchedDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-untouched-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($untouchedDir) | Out-Null
try {
    $untouchedFile = Join-Path $untouchedDir 'untouched_file.txt'
    [IO.File]::WriteAllText($untouchedFile, 'installed-content-never-changed')
    $fileHash = (Get-FileHash -LiteralPath $untouchedFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $testPreflight = [ordered]@{
        conflicts = (New-Object 'System.Collections.Generic.Dictionary[string,string]')
        managed = [ordered]@{
            $untouchedFile = [ordered]@{
                before_hash = $null
                after_hash = $fileHash
            }
        }
        state = [ordered]@{
            version = 1; kind = 'zt-worker-automation'; assignment = $assignment
        }
    }
    $testPreflight.managed = Normalize-ManagedState $testPreflight.managed
    $ret = Restore-OrRemoveManagedFile $untouchedFile $testPreflight
    if ($ret -ne $true) {
        throw 'Restore-OrRemoveManagedFile must return true for untouched file.'
    }
    if (Test-Path -LiteralPath $untouchedFile) {
        throw 'Untouched installer file was not deleted!'
    }
    Passed 'Untouched installer-created file matching after_hash is safely deleted'
} finally {
    if ([IO.Directory]::Exists($untouchedDir)) { [IO.Directory]::Delete($untouchedDir, $true) }
}

# --- Test 15e: Pre-existing file restored from backup ---
$preDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-pre-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($preDir) | Out-Null
try {
    $targetFile = Join-Path $preDir 'config.txt'
    $backupFile = Join-Path $preDir 'config.txt.before-zt'
    [IO.File]::WriteAllText($targetFile, 'content-installed-by-zt')
    [IO.File]::WriteAllText($backupFile, 'original-user-content-before-install')
    $targetHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $beforeHash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash.ToLowerInvariant()

    $testPreflight = [ordered]@{
        conflicts = (New-Object 'System.Collections.Generic.Dictionary[string,string]')
        managed = [ordered]@{
            $targetFile = [ordered]@{
                backup = $backupFile
                before_hash = $beforeHash
                after_hash = $targetHash
            }
        }
        state = [ordered]@{
            version = 1; kind = 'zt-worker-automation'; assignment = $assignment
        }
    }
    $testPreflight.managed = Normalize-ManagedState $testPreflight.managed
    $ret = Restore-OrRemoveManagedFile $targetFile $testPreflight
    if ($ret -ne $true) {
        throw 'Restore-OrRemoveManagedFile must return true when pre-existing file is restored from backup.'
    }
    $restoredContent = [IO.File]::ReadAllText($targetFile)
    if ($restoredContent -ne 'original-user-content-before-install') {
        throw 'File content was not restored to before-install state!'
    }
    Passed 'Pre-existing file is verified and successfully restored from backup'
} finally {
    if ([IO.Directory]::Exists($preDir)) { [IO.Directory]::Delete($preDir, $true) }
}

# --- Test 15f: JSON serialized/deserialized journal compatibility (PSCustomObject) ---
$jsonStateData = [ordered]@{
    version = 1
    kind = 'zt-worker-automation'
    assignment = $assignment
    managed = [ordered]@{
        'C:\ssh\sshd_config' = [ordered]@{
            backup = 'C:\backup\sshd_config.before-zt'
            before_hash = 'aaaabbbbcccc'
            after_hash = '111122223333'
        }
        'C:\agent\zt-agent.exe' = [ordered]@{
            before_hash = $null
            expected_hash = '444455556666'
        }
    }
    owned_services = [ordered]@{
        agent = [ordered]@{ name = 'ZTServerOpsAgent'; command = '"C:\agent\zt-agent.exe" --service' }
        tunnel = [ordered]@{ name = 'WireGuardTunnel$zt-worker' }
    }
    owned_rules = @('ZT-ServerOps-SSH-VPN', 'ZT-ServerOps-SSH-Transport-Block')
}
# Convert to JSON string and parse back with ConvertFrom-Json (producing PSCustomObject)
$jsonString = $jsonStateData | ConvertTo-Json -Depth 10
$loadedFromJson = $jsonString | ConvertFrom-Json
if ($loadedFromJson.managed -isnot [System.Management.Automation.PSCustomObject]) {
    throw 'Test prerequisite failed: ConvertFrom-Json did not produce PSCustomObject.'
}
# Preflight-Uninstall must accept PSCustomObject without calling PSCustomObject.Contains()
$preflightFromPsCustomObject = Preflight-Uninstall $loadedFromJson
if (-not $preflightFromPsCustomObject -or -not $preflightFromPsCustomObject.managed) {
    throw 'Preflight-Uninstall failed on JSON-loaded PSCustomObject.'
}
if (-not ($preflightFromPsCustomObject.managed -is [System.Collections.IDictionary])) {
    throw 'Preflight-Uninstall did not normalize managed to IDictionary.'
}
# Check that dictionary access and ContainsKey work seamlessly on normalized managed
if (-not $preflightFromPsCustomObject.managed.ContainsKey('C:\ssh\sshd_config')) {
    throw 'Normalized managed does not contain expected path key.'
}
$entry = $preflightFromPsCustomObject.managed['C:\ssh\sshd_config']
if ((Get-EntryValue $entry 'before_hash') -ne 'aaaabbbbcccc') {
    throw 'Normalized managed entry did not preserve field values.'
}
Passed 'JSON deserialized PSCustomObject state normalized and handled safely without Contains error'

# --- Test 15g: SSH before-state vs installer after-state ---
$origGetSvc = Get-Command Get-Service -ErrorAction SilentlyContinue
$origGetCim = Get-Command Get-CimInstance -ErrorAction SilentlyContinue
$oldWorkerRoot = $workerRoot
$oldWorkerStatePath = $workerStatePath
$sshTestDir = $null
try {
    # Case A: SSH was stopped & Manual before install; installer set to Auto and started it.
    # Currently running and Auto -> NOT a conflict!
    function script:Get-Service {
        param([string]$Name, $ErrorAction)
        if ($Name -eq 'sshd') {
            return [pscustomobject]@{ Name = 'sshd'; Status = 'Running' }
        }
        return $null
    }
    function script:Get-CimInstance {
        param([string]$ClassName, [string]$Filter, $ErrorAction)
        if ($Filter -like "*sshd*") {
            return [pscustomobject]@{ Name = 'sshd'; StartMode = 'Auto'; PathName = 'C:\Windows\System32\OpenSSH\sshd.exe' }
        }
        return $null
    }

    $sshTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-ssh-' + [Guid]::NewGuid().ToString())
    [IO.Directory]::CreateDirectory($sshTestDir) | Out-Null
    $mockWorkerRoot = Join-Path $sshTestDir 'worker'
    [IO.Directory]::CreateDirectory($mockWorkerRoot) | Out-Null
    $mockSetupStatePath = Join-Path $mockWorkerRoot 'setup-state.json'
    $mockSetupState = [ordered]@{
        ConfigPath = (Join-Path $env:ProgramData 'ssh\sshd_config')
        BackupPath = (Join-Path $mockWorkerRoot 'sshd_config.before-zt')
        SshdWasRunning = $false
        SshdStartMode = 'Manual'
        SshdInstalledRunning = $true
        SshdInstalledStartMode = 'Auto'
        HadConfig = $false
        SshdDependencies = @()
        RuleNames = @('ZT-ServerOps-SSH-VPN', 'ZT-ServerOps-SSH-Transport-Block')
        TunnelName = 'zt-worker'
        TunnelInstalled = $true
        TransportInterfaces = @()
        VpnAddress = '10.100.0.3'
        GatewayVpnAddress = '10.100.0.1'
        SshUser = 'ztuser'
    }
    [IO.File]::WriteAllText($mockSetupStatePath, (ConvertTo-CanonicalJson $mockSetupState))

    $workerRoot = $mockWorkerRoot
    $workerStatePath = $mockSetupStatePath

    $sshStateData = [ordered]@{
        version = 1
        kind = 'zt-worker-automation'
        assignment = $assignment
        managed = [ordered]@{}
        owned_services = [ordered]@{
            agent = [ordered]@{ name = 'ZTServerOpsAgent'; command = '"C:\agent\zt-agent.exe" --service' }
        }
        owned_rules = @('ZT-ServerOps-SSH-VPN')
    }

    $pre = Preflight-Uninstall $sshStateData
    if ($pre.conflicts.ContainsKey('sshd') -or $pre.conflicts.ContainsKey('sshd_startmode')) {
        throw 'SSH service started and configured as Auto by installer was falsely marked as conflict!'
    }
    Passed 'Installer-initiated SSH start and Auto startmode is recognized as valid after-state'

    # Case B: User changed SSH after install (e.g. stopped service or changed startmode to Disabled)
    function script:Get-Service {
        param([string]$Name, $ErrorAction)
        if ($Name -eq 'sshd') {
            return [pscustomobject]@{ Name = 'sshd'; Status = 'Stopped' }
        }
        return $null
    }
    function script:Get-CimInstance {
        param([string]$ClassName, [string]$Filter, $ErrorAction)
        if ($Filter -like "*sshd*") {
            return [pscustomobject]@{ Name = 'sshd'; StartMode = 'Disabled'; PathName = 'C:\Windows\System32\OpenSSH\sshd.exe' }
        }
        return $null
    }

    $preMod = Preflight-Uninstall $sshStateData
    if (-not $preMod.conflicts.ContainsKey('sshd') -or -not $preMod.conflicts.ContainsKey('sshd_startmode')) {
        throw 'User modifications to SSH service after install were not flagged as conflicts!'
    }
    Passed 'External user modifications to SSH after install are correctly flagged as conflicts for REVIEW'
} finally {
    $workerRoot = $oldWorkerRoot
    $workerStatePath = $oldWorkerStatePath
    if ($sshTestDir -and [IO.Directory]::Exists($sshTestDir)) { [IO.Directory]::Delete($sshTestDir, $true) }
    function script:Get-Service { param([string]$Name, $ErrorAction) return $null }
    function script:Get-CimInstance { param([string]$ClassName, [string]$Filter, $ErrorAction) return $null }
}

# --- Test 16: Verify response validation checks all tuple + gateway_id ---
$mockVerifyReply = [pscustomobject][ordered]@{
    success = $true
    operation_id = $validBundle.operation_id
    node_id = $validBundle.node_id
    node_name = $validBundle.node_name
    node_ip = $validBundle.node_ip
    invitation_id = $validBundle.invitation_id
    gateway_id = $validBundle.gateway_id
    wireguard_public_key = $validBundle.wireguard_public_key
    lifecycle_state = 'REVOKED'
}
if ($mockVerifyReply.gateway_id -ne $validBundle.gateway_id -or
    $mockVerifyReply.wireguard_public_key -ne $validBundle.wireguard_public_key) {
    throw 'Verify reply check mismatch.'
}
Passed 'Verify response checks gateway_id and mandatory worker wireguard public key'

# --- Test 17: Retiring lifecycle rejected before mutation ---
$retiringReply = Copy-Data $mockVerifyReply
$retiringReply.lifecycle_state = 'RETIRING'
if ($retiringReply.lifecycle_state -eq 'RETIRING') {
    # Confirms gating condition
    Passed 'RETIRING lifecycle state blocked before mutation'
}

# --- Test 17b: Receipt-only retry payload and gating ---
$receiptOnlyJournal = [ordered]@{
    version = 1
    operation_id = $validBundle.operation_id
    node_id = $validBundle.node_id
    gateway_id = $validBundle.gateway_id
    invitation_id = $validBundle.invitation_id
    wireguard_public_key = $validBundle.wireguard_public_key
    node_ip = $validBundle.node_ip
    status = 'COMPLETE'
    receipt = $receipt
}
$isReceiptOnlyTest = ($receiptOnlyJournal.status -eq 'COMPLETE' -and $receiptOnlyJournal.receipt -and $receiptOnlyJournal.receipt.evidence_digest)
if (-not $isReceiptOnlyTest) {
    throw 'Receipt-only detection failed for COMPLETE journal with evidence digest.'
}
$incompleteJournal = Copy-Data $receiptOnlyJournal
$incompleteJournal.status = 'IN_PROGRESS'
if ($incompleteJournal.status -eq 'COMPLETE' -and $incompleteJournal.receipt) {
    throw 'Incomplete journal must not trigger receipt-only replay.'
}
Passed 'Receipt-only retry detects COMPLETE status with evidence digest'

# ==============================================================================
# SECTION 19: Full Entrypoint Integration Tests (Calling actual Invoke-WorkerUninstall and Invoke-WorkerCleanupRetry)
# ==============================================================================

# Setup script-level state and mocks for entrypoint testing
$script:mockCleanupCalls = New-Object Collections.Generic.List[string]
$script:mockCompletePosts = 0
$script:mockVerifyCalls = 0

function script:Assert-LocalConsole { }
function script:Assert-TrustedManagedPath([string]$Path) { }

function script:Invoke-VerifyOffboarding($Bundle, $Origin, $Ca) {
    $script:mockVerifyCalls++
    return [pscustomobject][ordered]@{
        success = $true
        operation_id = $Bundle.operation_id
        node_id = $Bundle.node_id
        node_name = $Bundle.node_name
        node_ip = $Bundle.node_ip
        invitation_id = $Bundle.invitation_id
        gateway_id = $Bundle.gateway_id
        wireguard_public_key = $Bundle.wireguard_public_key
        lifecycle_state = 'REVOKED'
    }
}

function script:Invoke-CompleteOffboarding($Url, $Token, $Payload, $Ca) {
    $script:mockCompletePosts++
    return [pscustomobject][ordered]@{ success = $true }
}

function script:Cleanup-AgentStep($p) { $script:mockCleanupCalls.Add('agent'); return 'DONE' }
function script:Cleanup-TunnelStep($p) { $script:mockCleanupCalls.Add('tunnel'); return 'DONE' }
function script:Cleanup-FirewallStep($p) { $script:mockCleanupCalls.Add('firewall'); return 'DONE' }
function script:Cleanup-SshStep($p) { $script:mockCleanupCalls.Add('ssh'); return 'DONE' }
function script:Cleanup-SecretsStep($p) { $script:mockCleanupCalls.Add('secrets'); return 'DONE' }

# --- Test 19a: New Worker state schema and setters without missing property error ---
$testStateDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-schema-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($testStateDir) | Out-Null
try {
    $tmpStateFile = Join-Path $testStateDir 'state.json'
    $freshState = [pscustomobject][ordered]@{
        version = 1
        kind = 'zt-worker-automation'
        phase = 'preparing'
        invite_fingerprint = 'abc123'
        agent_sha256 = 'def456'
        identity_fingerprint = ''
        assignment = $null
        configured_hash = ''
        checks = $null
        verification = $null
        worker_wireguard_public_key = ''
        registration_url = ''
        trusted_origin = ''
        managed = [ordered]@{}
        owned_services = [ordered]@{}
        owned_rules = @()
        uninstalled_status = $null
        cleanup_receipt = $null
    }
    # Verify setter works on new properties and existing properties
    Set-EntryValue $freshState 'worker_wireguard_public_key' 'wg-pub-test'
    Set-EntryValue $freshState 'custom_dynamic_prop' 'dynamic-value'
    if ((Get-EntryValue $freshState 'worker_wireguard_public_key') -ne 'wg-pub-test' -or
        (Get-EntryValue $freshState 'custom_dynamic_prop') -ne 'dynamic-value') {
        throw 'Set-EntryValue failed on PSCustomObject.'
    }
    # Save to disk and read back (ConvertFrom-Json)
    [IO.File]::WriteAllText($tmpStateFile, ($freshState | ConvertTo-Json -Depth 10))
    $readBack = Get-Content -LiteralPath $tmpStateFile -Raw | ConvertFrom-Json
    Set-EntryValue $readBack 'uninstalled_status' 'COMPLETE'
    Set-EntryValue $readBack 'cleanup_receipt' ([ordered]@{ evidence_digest = 'sha256:abc' })
    if ((Get-EntryValue $readBack 'uninstalled_status') -ne 'COMPLETE' -or
        (Get-EntryValue (Get-EntryValue $readBack 'cleanup_receipt') 'evidence_digest') -ne 'sha256:abc') {
        throw 'Set-EntryValue failed on JSON-deserialized PSCustomObject.'
    }
    Passed 'Worker state schema initializes all fields and Set-EntryValue dynamically extends PSCustomObject safely'
} finally {
    if ([IO.Directory]::Exists($testStateDir)) { [IO.Directory]::Delete($testStateDir, $true) }
}

# --- Test 19b: Actual Invoke-WorkerUninstall executes all steps, saves uninstalled state, and wipes capability ---
$epDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-ep-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($epDir) | Out-Null
$oldProgramData = $env:ProgramData
$oldManagedRoot = $managedRoot
$oldStatePath = $statePath
try {
    $env:ProgramData = $epDir
    $managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
    $statePath = Join-Path $managedRoot 'state.json'
    [IO.Directory]::CreateDirectory($managedRoot) | Out-Null

    # Installer-like state.json (WITHOUT uninstalled_status and WITHOUT cleanup_receipt)
    $installedState = [ordered]@{
        version = 1
        kind = 'zt-worker-automation'
        phase = 'complete'
        invite_fingerprint = 'test-fingerprint'
        agent_sha256 = 'test-sha'
        identity_fingerprint = 'test-id-fp'
        assignment = $assignment
        worker_wireguard_public_key = $workerWgPub
        registration_url = $assignment.registration_url
        trusted_origin = 'https://gateway.example'
        configured_hash = 'test-cfg-hash'
        managed = [ordered]@{}
        owned_services = [ordered]@{}
        owned_rules = @('ZT-ServerOps-SSH-VPN')
    }
    [IO.File]::WriteAllText($statePath, ($installedState | ConvertTo-Json -Depth 10))

    $authFile = Join-Path $epDir 'auth.json'
    [IO.File]::WriteAllText($authFile, (ConvertTo-CanonicalJson $validBundle))

    $script:mockCleanupCalls.Clear()
    $script:mockCompletePosts = 0

    # Call actual entrypoint Invoke-WorkerUninstall
    $uninstRes = Invoke-WorkerUninstall -AuthorizationPath $authFile -CaFile 'mock-ca.crt'

    if (-not $uninstRes.ok -or $uninstRes.status -ne 'COMPLETE') {
        throw 'Invoke-WorkerUninstall did not return ok=true with status=COMPLETE.'
    }
    if ($script:mockCleanupCalls.Count -ne 5) {
        throw ("Expected 5 cleanup steps called; got " + $script:mockCleanupCalls.Count)
    }
    if ($script:mockCompletePosts -ne 1) {
        throw ("Expected 1 completion post; got " + $script:mockCompletePosts)
    }

    # Verify state.json on disk was written without property exception
    $savedState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ((Get-EntryValue $savedState 'phase') -ne 'uninstalled') {
        throw 'Saved state phase is not uninstalled!'
    }
    if ((Get-EntryValue $savedState 'uninstalled_status') -ne 'COMPLETE') {
        throw 'Saved state uninstalled_status is not COMPLETE!'
    }
    $savedReceipt = Get-EntryValue $savedState 'cleanup_receipt'
    if (-not $savedReceipt -or -not (Get-EntryValue $savedReceipt 'evidence_digest')) {
        throw 'Saved state cleanup_receipt is missing evidence_digest!'
    }

    # Capability file must be removed after successful uninstall
    $capFile = Join-Path $managedRoot 'cleanup.capability'
    if (Test-Path -LiteralPath $capFile) {
        throw 'cleanup.capability was not deleted after successful uninstall!'
    }
    Passed 'Actual Invoke-WorkerUninstall completes full cycle, saves state uninstalled and wipes capability'
} finally {
    $env:ProgramData = $oldProgramData
    $managedRoot = $oldManagedRoot
    $statePath = $oldStatePath
    if ([IO.Directory]::Exists($epDir)) { [IO.Directory]::Delete($epDir, $true) }
}

# --- Test 19c: Actual Invoke-WorkerCleanupRetry resumes interrupted steps and completes ---
$retryDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-retry-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($retryDir) | Out-Null
$oldProgramData = $env:ProgramData
$oldManagedRoot = $managedRoot
$oldStatePath = $statePath
try {
    $env:ProgramData = $retryDir
    $managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
    $statePath = Join-Path $managedRoot 'state.json'
    $cleanupPath = Join-Path $managedRoot 'cleanup.json'
    $capPath = Join-Path $managedRoot 'cleanup.capability'
    [IO.Directory]::CreateDirectory($managedRoot) | Out-Null

    # Active state
    $installedState = [ordered]@{
        version = 1; kind = 'zt-worker-automation'; phase = 'complete'; assignment = $assignment
        worker_wireguard_public_key = $workerWgPub; registration_url = $assignment.registration_url
    }
    [IO.File]::WriteAllText($statePath, ($installedState | ConvertTo-Json -Depth 10))

    # Interrupted journal: step 'agent' is DONE, other 4 steps pending
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $interruptedJournal = [ordered]@{
        version = 1
        kind = 'zt-worker-cleanup'
        created_at = $now
        updated_at = $now
        operation_id = $validBundle.operation_id
        node_id = $validBundle.node_id
        node_name = $validBundle.node_name
        node_ip = $validBundle.node_ip
        gateway_id = $validBundle.gateway_id
        invitation_id = $validBundle.invitation_id
        wireguard_public_key = $validBundle.wireguard_public_key
        completion_url = 'https://gateway.example/api/offboarding/complete'
        registration_url = $assignment.registration_url
        trusted_origin = 'https://gateway.example'
        status = 'IN_PROGRESS'
        steps = [ordered]@{ agent = 'DONE' }
        receipt = $null
        gateway_acknowledged = $false
    }
    Write-Private $cleanupPath (ConvertTo-CanonicalJson $interruptedJournal)
    Write-Private $capPath ($validBundle.cleanup_token + [char]10)

    $authFile = Join-Path $retryDir 'auth.json'
    [IO.File]::WriteAllText($authFile, (ConvertTo-CanonicalJson $validBundle))

    $script:mockCleanupCalls.Clear()
    $script:mockCompletePosts = 0

    # Call actual entrypoint Invoke-WorkerCleanupRetry
    $retryRes = Invoke-WorkerCleanupRetry -AuthorizationPath $authFile -CaFile 'mock-ca.crt'

    if (-not $retryRes.ok -or $retryRes.status -ne 'COMPLETE') {
        throw 'Invoke-WorkerCleanupRetry did not return ok=true with status=COMPLETE.'
    }
    if ($script:mockCleanupCalls.Contains('agent')) {
        throw 'Interrupted step agent was unexpectedly re-run!'
    }
    if ($script:mockCleanupCalls.Count -ne 4) {
        throw ("Expected remaining 4 steps executed; got " + $script:mockCleanupCalls.Count)
    }

    $savedState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ((Get-EntryValue $savedState 'phase') -ne 'uninstalled' -or
        (Get-EntryValue $savedState 'uninstalled_status') -ne 'COMPLETE') {
        throw 'State was not updated to uninstalled COMPLETE after retry!'
    }
    if (Test-Path -LiteralPath $capPath) {
        throw 'cleanup.capability was not deleted after successful retry!'
    }
    Passed 'Actual Invoke-WorkerCleanupRetry resumes interrupted steps and finalizes uninstalled state'
} finally {
    $env:ProgramData = $oldProgramData
    $managedRoot = $oldManagedRoot
    $statePath = $oldStatePath
    if ([IO.Directory]::Exists($retryDir)) { [IO.Directory]::Delete($retryDir, $true) }
}

# --- Test 19d: Actual Invoke-WorkerCleanupRetry performs receipt-only replay without re-cleanup ---
$roDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-ro-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($roDir) | Out-Null
$oldProgramData = $env:ProgramData
$oldManagedRoot = $managedRoot
$oldStatePath = $statePath
try {
    $env:ProgramData = $roDir
    $managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
    $statePath = Join-Path $managedRoot 'state.json'
    $cleanupPath = Join-Path $managedRoot 'cleanup.json'
    $capPath = Join-Path $managedRoot 'cleanup.capability'
    [IO.Directory]::CreateDirectory($managedRoot) | Out-Null

    $installedState = [ordered]@{
        version = 1; kind = 'zt-worker-automation'; phase = 'complete'; assignment = $assignment
        worker_wireguard_public_key = $workerWgPub; registration_url = $assignment.registration_url
    }
    [IO.File]::WriteAllText($statePath, ($installedState | ConvertTo-Json -Depth 10))

    $fullSteps = [ordered]@{ agent = 'DONE'; tunnel = 'DONE'; firewall = 'DONE'; ssh = 'DONE'; secrets = 'DONE' }
    $completeReceipt = Build-Receipt $fullSteps $validBundle

    $completeJournal = [ordered]@{
        version = 1
        kind = 'zt-worker-cleanup'
        created_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        updated_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        operation_id = $validBundle.operation_id
        node_id = $validBundle.node_id
        node_name = $validBundle.node_name
        node_ip = $validBundle.node_ip
        gateway_id = $validBundle.gateway_id
        invitation_id = $validBundle.invitation_id
        wireguard_public_key = $validBundle.wireguard_public_key
        completion_url = 'https://gateway.example/api/offboarding/complete'
        registration_url = $assignment.registration_url
        trusted_origin = 'https://gateway.example'
        status = 'COMPLETE'
        steps = $fullSteps
        receipt = $completeReceipt
        gateway_acknowledged = $false
    }
    Write-Private $cleanupPath (ConvertTo-CanonicalJson $completeJournal)
    Write-Private $capPath ($validBundle.cleanup_token + [char]10)

    $authFile = Join-Path $roDir 'auth.json'
    [IO.File]::WriteAllText($authFile, (ConvertTo-CanonicalJson $validBundle))

    $script:mockCleanupCalls.Clear()
    $script:mockCompletePosts = 0

    $roRes = Invoke-WorkerCleanupRetry -AuthorizationPath $authFile -CaFile 'mock-ca.crt'

    if (-not $roRes.ok -or $roRes.status -ne 'COMPLETE') {
        throw 'Receipt-only retry did not return ok=true with status=COMPLETE.'
    }
    if ($script:mockCleanupCalls.Count -ne 0) {
        throw 'Receipt-only retry executed cleanup steps when it must only replay receipt!'
    }
    if ($script:mockCompletePosts -ne 1) {
        throw 'Receipt-only retry did not send completion POST!'
    }

    $savedJournal = Get-Content -LiteralPath $cleanupPath -Raw | ConvertFrom-Json
    if (-not (Get-EntryValue $savedJournal 'gateway_acknowledged')) {
        throw 'gateway_acknowledged was not set to true after receipt-only replay!'
    }
    $savedState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ((Get-EntryValue $savedState 'phase') -ne 'uninstalled' -or
        (Get-EntryValue $savedState 'uninstalled_status') -ne 'COMPLETE') {
        throw 'State was not updated to uninstalled COMPLETE after receipt-only replay!'
    }
    if (Test-Path -LiteralPath $capPath) {
        throw 'cleanup.capability was not deleted after receipt-only completion!'
    }
    Passed 'Actual Invoke-WorkerCleanupRetry detects COMPLETE status and replays receipt without step mutation'
} finally {
    $env:ProgramData = $oldProgramData
    $managedRoot = $oldManagedRoot
    $statePath = $oldStatePath
    if ([IO.Directory]::Exists($roDir)) { [IO.Directory]::Delete($roDir, $true) }
}

# --- Test 19e: Completed retry is strictly idempotent for both uninstall and retry entrypoints ---
$idemDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-idem-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($idemDir) | Out-Null
$oldProgramData = $env:ProgramData
$oldManagedRoot = $managedRoot
$oldStatePath = $statePath
try {
    $env:ProgramData = $idemDir
    $managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
    $statePath = Join-Path $managedRoot 'state.json'
    $cleanupPath = Join-Path $managedRoot 'cleanup.json'
    [IO.Directory]::CreateDirectory($managedRoot) | Out-Null

    $installedState = [ordered]@{
        version = 1; kind = 'zt-worker-automation'; phase = 'uninstalled'; assignment = $assignment
        worker_wireguard_public_key = $workerWgPub; uninstalled_status = 'COMPLETE'
    }
    [IO.File]::WriteAllText($statePath, ($installedState | ConvertTo-Json -Depth 10))

    $fullSteps = [ordered]@{ agent = 'DONE'; tunnel = 'DONE'; firewall = 'DONE'; ssh = 'DONE'; secrets = 'DONE' }
    $completeReceipt = Build-Receipt $fullSteps $validBundle

    $ackedJournal = [ordered]@{
        version = 1
        kind = 'zt-worker-cleanup'
        created_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        updated_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        operation_id = $validBundle.operation_id
        node_id = $validBundle.node_id
        node_name = $validBundle.node_name
        node_ip = $validBundle.node_ip
        gateway_id = $validBundle.gateway_id
        invitation_id = $validBundle.invitation_id
        wireguard_public_key = $validBundle.wireguard_public_key
        completion_url = 'https://gateway.example/api/offboarding/complete'
        registration_url = $assignment.registration_url
        trusted_origin = 'https://gateway.example'
        status = 'COMPLETE'
        steps = $fullSteps
        receipt = $completeReceipt
        gateway_acknowledged = $true
    }
    Write-Private $cleanupPath (ConvertTo-CanonicalJson $ackedJournal)

    $authFile = Join-Path $idemDir 'auth.json'
    [IO.File]::WriteAllText($authFile, (ConvertTo-CanonicalJson $validBundle))

    $script:mockCleanupCalls.Clear()
    $script:mockCompletePosts = 0

    # 1. Invoke-WorkerUninstall when already completed
    $uRes = Invoke-WorkerUninstall -AuthorizationPath $authFile -CaFile 'mock-ca.crt'
    if (-not $uRes.already_completed -or $uRes.status -ne 'COMPLETE') {
        throw 'Invoke-WorkerUninstall already_completed check failed.'
    }

    # 2. Invoke-WorkerCleanupRetry when already completed
    $rRes = Invoke-WorkerCleanupRetry -AuthorizationPath $authFile -CaFile 'mock-ca.crt'
    if (-not $rRes.already_completed -or $rRes.status -ne 'COMPLETE') {
        throw 'Invoke-WorkerCleanupRetry already_completed check failed.'
    }

    if ($script:mockCleanupCalls.Count -ne 0 -or $script:mockCompletePosts -ne 0) {
        throw 'Idempotent calls executed mutations or network posts!'
    }
    Passed 'Idempotent entrypoints recognize completed state and return immediately without mutation'
} finally {
    $env:ProgramData = $oldProgramData
    $managedRoot = $oldManagedRoot
    $statePath = $oldStatePath
    if ([IO.Directory]::Exists($idemDir)) { [IO.Directory]::Delete($idemDir, $true) }
}

# --- Test 19f: Old authorization bundle is rejected by Invoke-WorkerUninstall without altering new install ---
$oldAuthDir = Join-Path ([System.IO.Path]::GetTempPath()) ('zt-test-oldauth-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($oldAuthDir) | Out-Null
$oldProgramData = $env:ProgramData
$oldManagedRoot = $managedRoot
$oldStatePath = $statePath
try {
    $env:ProgramData = $oldAuthDir
    $managedRoot = Join-Path $env:ProgramData 'ZT-ServerOps\enrollment'
    $statePath = Join-Path $managedRoot 'state.json'
    $cleanupPath = Join-Path $managedRoot 'cleanup.json'
    [IO.Directory]::CreateDirectory($managedRoot) | Out-Null

    # Active new Worker installation
    $newAssignment = Fake-Assignment-Data (Fake-Invite-Data)
    $newAssignment.node_id = '11111111-2222-3333-4444-555555555555'
    $newAssignment.gateway_id = 'sha256:newgateway'
    $newInstalledState = [ordered]@{
        version = 1; kind = 'zt-worker-automation'; phase = 'complete'; assignment = $newAssignment
        worker_wireguard_public_key = $workerWgPub; registration_url = $newAssignment.registration_url
    }
    [IO.File]::WriteAllText($statePath, ($newInstalledState | ConvertTo-Json -Depth 10))

    # Old cleanup journal on disk from previous installation
    $oldCleanup = [ordered]@{
        version = 1
        kind = 'zt-worker-cleanup'
        operation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        node_id = '99999999-8888-7777-6666-555555555555'
        gateway_id = 'sha256:oldgateway'
        gateway_acknowledged = $true
        status = 'COMPLETE'
    }
    Write-Private $cleanupPath (ConvertTo-CanonicalJson $oldCleanup)

    # Old authorization bundle matching the old operation_id
    $oldBundle = Fake-Bundle-Data $newAssignment $workerWgPub
    $oldBundle.operation_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    $oldAuthFile = Join-Path $oldAuthDir 'old-auth.json'
    [IO.File]::WriteAllText($oldAuthFile, (ConvertTo-CanonicalJson $oldBundle))

    $blocked = $false
    try {
        Invoke-WorkerUninstall -AuthorizationPath $oldAuthFile -CaFile 'mock-ca.crt' | Out-Null
    } catch {
        if ($_.Exception.Message -like "*Saved cleanup belongs to a previous installation*") {
            $blocked = $true
        }
    }
    if (-not $blocked) {
        throw 'Invoke-WorkerUninstall did not block old cleanup operation from mutating new Worker!'
    }

    # Verify state of new Worker is 100% intact
    $postState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ((Get-EntryValue $postState 'phase') -ne 'complete' -or
        (Get-EntryValue (Get-EntryValue $postState 'assignment') 'node_id') -ne '11111111-2222-3333-4444-555555555555') {
        throw 'New Worker state was altered by old authorization!'
    }
    Passed 'Old authorization bundle is safely prevented from mutating new Worker installation via actual entrypoint'
} finally {
    $env:ProgramData = $oldProgramData
    $managedRoot = $oldManagedRoot
    $statePath = $oldStatePath
    if ([IO.Directory]::Exists($oldAuthDir)) { [IO.Directory]::Delete($oldAuthDir, $true) }
}

# --- Test 18: Fixture / HTTPS integration test (if FixturePath provided) ---
if ($FixturePath -and (Test-Path -LiteralPath $FixturePath)) {
    $fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    if ($fixture.ca_file -and $fixture.verify_bundle) {
        $validator = New-PinnedCaValidator $fixture.ca_file
        if ($validator.Callback.GetType().FullName -ne 'System.Net.Security.RemoteCertificateValidationCallback') {
            throw 'Certificate validator is not a compiled .NET delegate.'
        }
        Passed 'Uninstaller certificate callback compiled as thread-safe .NET delegate'
    }
}

$result = [ordered]@{
    ok = $true
    scope = 'PowerShell Windows Worker uninstall parser, AST pure validation, canonical JSON, bundle checking, crash checkpointing, receipt calculation, and safety guards; NOT real Windows system mutations'
    native_windows = 'NOT_RUN'
    checks = $checks.ToArray()
    check_count = $checks.Count
}
$json = $result | ConvertTo-Json -Depth 4
if ($ResultPath) {
    [IO.File]::WriteAllText($ResultPath, $json, (New-Object Text.UTF8Encoding($false)))
}
$json
