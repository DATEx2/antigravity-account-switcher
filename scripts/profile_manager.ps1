<#
.SYNOPSIS
    Antigravity Profile Manager - Manages user profiles for account switching
.DESCRIPTION
    This script handles saving, loading, listing, deleting, and renaming Antigravity profiles.
    Each profile is a copy of the User Data directory containing authentication state.
.PARAMETER Action
    The action to perform: Save, Load, List, Delete, Rename
.PARAMETER ProfileName
    The name of the profile (required for Save, Load, Delete, Rename)
.PARAMETER NewProfileName
    The new name for the profile (required for Rename)
.PARAMETER MaxProfiles
    Maximum number of profiles allowed (default: unlimited)
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("Save", "Load", "List", "Delete", "Rename", "SetEmail")]
    [string]$Action,
    
    [Parameter(Mandatory=$false)]
    [string]$ProfileName,
    
    [Parameter(Mandatory=$false)]
    [string]$NewProfileName,

    [Parameter(Mandatory=$false)]
    [string]$Email,
    
    [Parameter(Mandatory=$false)]
    [int]$MaxProfiles = 2000
)

# Configuration
$AntigravityDataPath = "$env:APPDATA\Antigravity"
$ProfilesStorePath = "$env:APPDATA\Antigravity\Profiles"
$UserDataPath = "$AntigravityDataPath\User"
$ProcessName = "Antigravity"

# Ensure profiles directory exists
if (-not (Test-Path $ProfilesStorePath)) {
    New-Item -ItemType Directory -Path $ProfilesStorePath -Force | Out-Null
}

function Get-Profiles {
    $profiles = @()
    if (Test-Path $ProfilesStorePath) {
        Get-ChildItem -Path $ProfilesStorePath -Directory | ForEach-Object {
            $infoFile = Join-Path $_.FullName "profile_info.json"
            $email = ""
            if (Test-Path $infoFile) {
                try {
                    $info = Get-Content $infoFile | ConvertFrom-Json
                    $email = $info.Email
                } catch {}
            }
            $profiles += @{
                Name = $_.Name
                Email = $email
                Created = $_.CreationTime.ToString("yyyy-MM-dd HH:mm")
            }
        }
    }
    return $profiles
}

function Save-Profile {
    param([string]$Name, [string]$Email)
    
    # Validate profile name
    if ($Name -match '[\\/:*?"<>|]') {
        Write-Error "Profile name contains invalid characters"
        exit 1
    }
    
    # Check if User Data exists
    if (-not (Test-Path $UserDataPath)) {
        Write-Error "User Data directory not found at: $UserDataPath"
        exit 1
    }
    
    $targetPath = Join-Path $ProfilesStorePath $Name
    $targetGlobalStorage = Join-Path $targetPath "globalStorage"
    
    # Ensure profile directory exists
    if (-not (Test-Path $targetPath)) {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
    } else {
        # If it exists, we only want to refresh the globalStorage part
        if (Test-Path $targetGlobalStorage) {
            Remove-Item -Path $targetGlobalStorage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    
    # Copy ONLY globalStorage to profile (Isolates account from settings/history)
    $sourceGlobalStorage = Join-Path $UserDataPath "globalStorage"
    if (Test-Path $sourceGlobalStorage) {
        Write-Host "Saving account data for profile '$Name'..."
        Copy-Item -Path $sourceGlobalStorage -Destination $targetGlobalStorage -Recurse -Force
    } else {
        Write-Warning "globalStorage not found in User directory. Profile might be incomplete."
    }

    # Save extra info
    if ($Email) {
        $info = @{ Email = $Email }
        $info | ConvertTo-Json | Out-File (Join-Path $targetPath "profile_info.json") -Encoding utf8
    }
    
    Write-Host "Profile '$Name' (Account Data) saved successfully."
    Write-Output @{ Success = $true; Message = "Account data saved" } | ConvertTo-Json
}

function Switch-Profile {
    param([string]$Name)
    
    $profilePath = Join-Path $ProfilesStorePath $Name
    $sourceGlobalStorage = Join-Path $profilePath "globalStorage"
    
    if (-not (Test-Path $profilePath)) {
        Write-Error "Profile '$Name' not found"
        exit 1
    }
    
    # Find Antigravity executable
    $exePath = "$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe"
    if (-not (Test-Path $exePath)) {
        $exePath = "$env:PROGRAMFILES\Antigravity\Antigravity.exe"
    }
    if (-not (Test-Path $exePath)) {
        Write-Error "Could not find Antigravity executable"
        exit 1
    }
    
    # Stop Antigravity processes
    Write-Host "Stopping Antigravity..."
    $processes = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($processes) {
        $processes | Stop-Process -Force
        Start-Sleep -Seconds 3
    }
    
    # Identify what to copy (compatibility with old full-user profiles)
    $actualSource = $sourceGlobalStorage
    if (-not (Test-Path $sourceGlobalStorage)) {
        # If the profile doesn't have a globalStorage folder inside, maybe the profile ITSELF is a globalStorage folder?
        # Or it's an old-style full profile. Let's check for state.vscdb in the root
        if (Test-Path (Join-Path $profilePath "state.vscdb")) {
            $actualSource = $profilePath
        } else {
            Write-Error "Profile '$Name' does not contain valid account data (globalStorage or state.vscdb)."
            exit 1
        }
    }

    # Target point
    $targetGlobalStorage = Join-Path $UserDataPath "globalStorage"
    
    # Backup ONLY current globalStorage
    $backupPath = "${targetGlobalStorage}_switching_backup"
    if (Test-Path $backupPath) {
        Remove-Item -Path $backupPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    
    if (Test-Path $targetGlobalStorage) {
        Write-Host "Backing up current account data..."
        Rename-Item -Path $targetGlobalStorage -NewName $backupPath -Force -ErrorAction SilentlyContinue
    }
    
    # Copy NEW account data to globalStorage
    Write-Host "Loading account data from profile '$Name'..."
    Copy-Item -Path $actualSource -Destination $targetGlobalStorage -Recurse -Force
    
    # Clean up backup in background
    if (Test-Path $backupPath) {
        Start-Job -ScriptBlock { param($p) Start-Sleep -Seconds 10; Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue } -ArgumentList $backupPath | Out-Null
    }
    
    # Restart Antigravity
    Write-Host "Restarting Antigravity..."
    Start-Sleep -Seconds 2
    Start-Process "explorer.exe" -ArgumentList "`"$exePath`""
    
    Write-Host "Account switched to '$Name' successfully. Settings and history were preserved."
    @{ Success = $true; Message = "Account switched"; Restarted = $true } | ConvertTo-Json -Compress
}

function Remove-Profile {
    param([string]$Name)
    
    $profilePath = Join-Path $ProfilesStorePath $Name
    
    if (-not (Test-Path $profilePath)) {
        Write-Error "Profile '$Name' not found"
        exit 1
    }
    
    Remove-Item -Path $profilePath -Recurse -Force
    Write-Host "Profile '$Name' deleted."
    Write-Output @{ Success = $true; Message = "Profile deleted" } | ConvertTo-Json
}

function List-Profiles {
    $profiles = @(Get-Profiles)
    $count = $profiles.Length
    
    if ($count -eq 0) {
        Write-Host "No profiles saved yet."
        $result = @{ Profiles = @(); Count = 0; MaxProfiles = $MaxProfiles }
    } else {
        Write-Host "Saved Profiles ($count total):"
        Write-Host "-----------------------------------"
        foreach ($profile in $profiles) {
            Write-Host "  - $($profile.Name) (Created: $($profile.Created), Size: $($profile.Size) MB)"
        }
        $result = @{ Profiles = $profiles; Count = $count; MaxProfiles = $MaxProfiles }
    }
    $result | ConvertTo-Json -Depth 3 -Compress
}

function Rename-Profile {
    param([string]$OldName, [string]$NewName)
    
    $oldPath = Join-Path $ProfilesStorePath $OldName
    $newPath = Join-Path $ProfilesStorePath $NewName
    
    if (-not (Test-Path $oldPath)) {
        Write-Error "Profile '$OldName' not found"
        exit 1
    }
    
    if (Test-Path $newPath) {
        Write-Error "Profile '$NewName' already exists"
        exit 1
    }
    
    Rename-Item -Path $oldPath -NewName $NewName -Force
    Write-Host "Profile '$OldName' renamed to '$NewName'."
    Write-Output @{ Success = $true; Message = "Profile renamed" } | ConvertTo-Json
}

function Set-Email {
    param([string]$Name, [string]$Email)
    $path = Join-Path $ProfilesStorePath $Name
    if (-not (Test-Path $path)) {
        Write-Error "Profile '$Name' not found"
        exit 1
    }
    $info = @{ Email = $Email }
    $info | ConvertTo-Json | Out-File (Join-Path $path "profile_info.json") -Encoding utf8
    Write-Host "Email updated for profile '$Name'."
    Write-Output @{ Success = $true; Message = "Email updated" } | ConvertTo-Json
}

# Execute action
switch ($Action) {
    "Save" {
        if (-not $ProfileName) {
            Write-Error "ProfileName is required for Save action"
            exit 1
        }
        Save-Profile -Name $ProfileName -Email $Email
    }
    "SetEmail" {
        if (-not $ProfileName) {
            Write-Error "ProfileName is required for SetEmail action"
            exit 1
        }
        Set-Email -Name $ProfileName -Email $Email
    }
    "Load" {
        if (-not $ProfileName) {
            Write-Error "ProfileName is required for Load action"
            exit 1
        }
        Switch-Profile -Name $ProfileName
    }
    "List" {
        List-Profiles
    }
    "Delete" {
        if (-not $ProfileName) {
            Write-Error "ProfileName is required for Delete action"
            exit 1
        }
        Remove-Profile -Name $ProfileName
    }
    "Rename" {
        if (-not $ProfileName -or -not $NewProfileName) {
            Write-Error "Both ProfileName and NewProfileName are required for Rename action"
            exit 1
        }
        Rename-Profile -OldName $ProfileName -NewName $NewProfileName
    }
}
