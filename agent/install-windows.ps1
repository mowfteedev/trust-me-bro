#Requires -Version 5.1
<#
Install a locally built 64-bit Agent as a native Windows service.
Example (elevated PowerShell):
  .\install-windows.ps1 -BinaryPath .\zt-agent-windows-amd64.exe -ConfigPath .\agent-config.json
No download, firewall changes or token argument. Reinstall keeps config unless -UpdateConfig.
ValidateOnly checks binary/config without installing, sampling or sending HTTP.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BinaryPath,
    [string]$ConfigPath,
    [switch]$UpdateConfig,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$serviceName = 'ZTServerOpsAgent'
$installDir = Join-Path $env:ProgramData 'ZT-ServerOps\agent'
$targetBinary = Join-Path $installDir 'zt-agent.exe'
$targetConfig = Join-Path $installDir 'config.json'
$logsDir = Join-Path $installDir 'logs'

function Assert-NoReparsePoint([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Refusing a reparse point in the installation path.'
            }
        }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Set-PrivateDirectory([string]$Path, [bool]$ServiceCanWrite) {
    Assert-NoReparsePoint $Path
    if (Test-Path -LiteralPath $Path) {
        $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18', 'S-1-5-32-544')) {
            throw 'Existing installation directory must be owned by SYSTEM or Administrators.'
        }
    } else {
        [IO.Directory]::CreateDirectory($Path) | Out-Null
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $acl.SetOwner($admins)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    $localService = New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
    $rights = if ($ServiceCanWrite) { 'Modify' } else { 'ReadAndExecute' }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($localService, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-PrivateFile([string]$Path) {
    Assert-NoReparsePoint $Path
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $acl.SetOwner($admins)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
    }
    $localService = New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($localService, 'ReadAndExecute', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required.' }
$sourceBinary = (Resolve-Path -LiteralPath $BinaryPath).Path
Assert-NoReparsePoint $sourceBinary
if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) { throw 'BinaryPath must be a trusted local Agent executable.' }

if ($ConfigPath) {
    $sourceConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
    Assert-NoReparsePoint $sourceConfig
} else {
    $sourceConfig = $targetConfig
}
if (-not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) { throw 'A JSON ConfigPath is required for the first installation.' }

# Validate the effective config before stopping an existing working service.
$effectiveConfig = if ((Test-Path -LiteralPath $targetConfig) -and -not $UpdateConfig) { $targetConfig } else { $sourceConfig }
Assert-NoReparsePoint $effectiveConfig
# Native exit status is required; PowerShell ErrorActionPreference alone does not check it.
& $sourceBinary --validate-config --config $effectiveConfig
if ($LASTEXITCODE -ne 0) { throw 'Agent/config validation failed; installation has not changed.' }
if ($ValidateOnly) {
    Write-Host 'Binary/config validation passed; no service, network or installation changes.'
    return
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run installation from an elevated PowerShell.' }
if ($UpdateConfig -and -not $ConfigPath) { throw '-UpdateConfig requires -ConfigPath.' }
Assert-NoReparsePoint $targetBinary
Assert-NoReparsePoint $targetConfig
Assert-NoReparsePoint $logsDir

# Secure the parent too: an unprivileged user must not replace the agent directory.
Set-PrivateDirectory (Split-Path -Parent $installDir) $false
Set-PrivateDirectory $installDir $false
Set-PrivateDirectory $logsDir $true
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService -and $existingService.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
}

if (-not (Test-Path -LiteralPath $targetConfig) -or $UpdateConfig) {
    $nextConfig = Join-Path $installDir 'config.json.new'
    Assert-NoReparsePoint $nextConfig
    if ([IO.Path]::GetFullPath($sourceConfig) -ne [IO.Path]::GetFullPath($targetConfig)) {
        Copy-Item -LiteralPath $sourceConfig -Destination $nextConfig -Force
        Set-PrivateFile $nextConfig
        Move-Item -LiteralPath $nextConfig -Destination $targetConfig -Force
    }
}
Set-PrivateFile $targetConfig
& $sourceBinary --validate-config --config $targetConfig
if ($LASTEXITCODE -ne 0) { throw 'Preserved service configuration is invalid; fix config and rerun installer.' }

if ([IO.Path]::GetFullPath($sourceBinary) -ne [IO.Path]::GetFullPath($targetBinary)) {
    $nextBinary = Join-Path $installDir 'zt-agent.exe.new'
    Assert-NoReparsePoint $nextBinary
    Copy-Item -LiteralPath $sourceBinary -Destination $nextBinary -Force
    Set-PrivateFile $nextBinary
    Move-Item -LiteralPath $nextBinary -Destination $targetBinary -Force
}
Set-PrivateFile $targetBinary
$command = '"' + $targetBinary + '" --service --config "' + $targetConfig + '"'

# LocalService has no administrator rights and needs no stored account password.
# CIM passes the quoted ImagePath as a structured string, avoiding legacy
# Windows PowerShell native-argument quoting problems with spaces in paths.
if ($existingService) {
    $serviceCim = Get-CimInstance -ClassName Win32_Service -Filter "Name='$serviceName'"
    $result = Invoke-CimMethod -InputObject $serviceCim -MethodName Change -Arguments @{
        PathName = $command; StartMode = 'Automatic'; StartName = 'NT AUTHORITY\LocalService'; StartPassword = ''
    }
} else {
    $result = Invoke-CimMethod -ClassName Win32_Service -MethodName Create -Arguments @{
        Name = $serviceName; DisplayName = 'ZT-ServerOps Mini-Agent'; PathName = $command
        ServiceType = [byte]16; ErrorControl = [byte]1; StartMode = 'Automatic'; StartName = 'NT AUTHORITY\LocalService'
    }
}
if ($result.ReturnValue -ne 0) { throw ('Cannot create/configure Agent service (Windows code ' + $result.ReturnValue + ').') }
& sc.exe config $serviceName start= delayed-auto
if ($LASTEXITCODE -ne 0) { throw 'Cannot configure delayed service start.' }
& sc.exe description $serviceName 'Outbound WireGuard telemetry; logs in ProgramData\ZT-ServerOps\agent\logs.'
if ($LASTEXITCODE -ne 0) { throw 'Cannot set service description.' }
& sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/15000/restart/30000
if ($LASTEXITCODE -ne 0) { throw 'Cannot configure service recovery.' }
& sc.exe failureflag $serviceName 1
if ($LASTEXITCODE -ne 0) { throw 'Cannot configure service recovery flag.' }
Start-Service -Name $serviceName
(Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
Write-Host 'Agent service installed/running. Existing config was kept unless -UpdateConfig was specified.'
Write-Host ('Inspect real beacon ACK/errors: Get-Content "' + (Join-Path $logsDir 'agent.log') + '" -Tail 20')
Write-Host 'Service controls: Stop-Service ZTServerOpsAgent; Start-Service ZTServerOpsAgent'
Write-Host 'Running service status alone does not prove telemetry delivery; confirm ACK and dashboard heartbeat.'
