# Antigravity Multi-Account Switcher
**Version 2.13.3** - Scrollbar Fix & UX Improvements

Seamlessly switch between multiple Google accounts in Antigravity to bypass model rate limits without manual re-login.

## Features

### 🎨 Colorful Profile Buttons
- **5 profile slot buttons** in the status bar with distinct colors (Blue, Green, Orange, Purple, Pink)
- **One-click switching** - no confirmation dialogs
- Empty slots are grayed out with slot numbers

### ➕ Easy Profile Management
- **Save button (+)** - Save your current session as a new profile
- **Delete button (🗑️)** - Remove unwanted profiles
- Profiles are stored in `%APPDATA%\Antigravity\Profiles`

### ⚠️ Rate Limit Detection
- Automatically monitors for rate limit errors (supports Gemini and Claude)
- When detected, prompts you to switch to another account
- 1-minute cooldown between alerts to avoid spam

---

## Installation Instructions

### Method 1: Install from VSIX (Recommended)

1. **Download** the `antigravity-account-switcher-2.13.3.vsix` file
2. **Open Antigravity**
3. Press `Ctrl+Shift+P` to open Command Palette
4. Type: `Extensions: Install from VSIX...`
5. Select the downloaded `.vsix` file
6. Click **Reload** when prompted (or press `Ctrl+Shift+P` → `Developer: Reload Window`)

### Method 2: Command Line Install

```powershell
# Run this in PowerShell or Command Prompt
& "$env:LOCALAPPDATA\Programs\Antigravity\bin\antigravity.cmd" --install-extension "path\to\antigravity-account-switcher-2.13.3.vsix"
```

### Method 3: Manual Install (Copy Files)

1. Navigate to: `%USERPROFILE%\.vscode\extensions\` (or `%USERPROFILE%\.antigravity\extensions\`)
2. Create folder: `antigravity-account-switcher-2.13.3`
3. Copy these files into it:
   - `extension.js`
   - `package.json`
   - `scripts\profile_manager.ps1`
4. Restart Antigravity

---

## How It Works

1. **Save a Profile**: Log into a Google account in Antigravity, then click the **+** button and enter a name
2. **Switch Profiles**: Click any colored profile button to instantly switch (Antigravity will restart)
3. **Rate Limit Auto-Switch**: When you hit a rate limit, a prompt appears offering to switch accounts

## Commands

| Command | Description |
|---------|-------------|
| `Antigravity: Save Current Profile` | Save current session |
| `Antigravity: Switch Profile` | Switch via picker |
| `Antigravity: Delete Profile` | Delete a profile |
| `Antigravity: List Profiles` | Show saved profiles |

## Requirements

- Windows 10/11
- Antigravity IDE
- PowerShell (included with Windows)

## Notes

- Profile switching **restarts Antigravity** to apply changes
- Each profile stores the complete authentication state
- Unlimited profiles supported (default limit: 2000+)

### 2.13.3
- Fixed tab bar scrollbar (isolated Dashboard tab from scroll container)
- Improved visual separation of fixed tabs

### 2.13.2
- Added horizontal scrolling to tab bar with mouse wheel
- Smoother navigation for users with many accounts

### 2.13.1
- Made Dashboard tab fixed (sticky) while other tabs scroll
- Minor UI improvements for tab contrast

### 2.13.0
- Isolated account-specific details (globalStorage) to keep settings and history global
- Fixed data loss issues during account switching
- Updated status bar tooltips to clarify shared settings
- Added compatibility for legacy full-profile folders

### 2.12.0
- Removed the 20 account limit and set it to unlimited (2000+)
- Updated all configuration defaults to support unlimited profiles
- Fixed discrepancies between package.json and extension defaults
- Synced extension.js console logs and README versioning

### 2.10.6
- Added enhanced sorting in Dashboard: cycle between **Name**, **Email**, and **Domain** (alphabetic & reverse)
- Added domain-based email styling (e.g., green for @datex2.bike, transparent for @gmail.com)
- Cleaned up `workspaceStorage` in all profiles to save disk space
- Improved email readability with subtle background colors and borders

### 2.10.5
- Added Search Bar to Dashboard to filter results by name and email
- Added result count to Dashboard header (e.g., "5 of 20 Saved Accounts")
- Improved search UX with automatic focus and cursor position persistence
- Fixed JS escaping issues in webview communication for search queries

### 2.10.4
- Added "Last Refresh" to Status column and made it sortable
- Improved tab text contrast for better readability
- Fixed vertical scrollbar on Dashboard tabs
- Removed brackets `[ ]` from tab info
- Always show reset time in tabs, even for accounts at 100%

### 2.10.2
- Added sortable columns in Dashboard (Name, % and Next Reset)
- Added availability prefix and short reset time to tab labels
- Added Account Count to Dashboard header

### 2.10.1
- Added email address display in status bar tooltips

### 2.10.0
- Updated Dashboard "Next Reset" to show exact time even for 100% accounts
- Optimized Dashboard performance by removing expensive recursive size calculations
- Reduced Dashboard loading time from "very slow" to "instant"

### 2.9.10
- Fixed `SyntaxError: await is only valid in async functions` during activation

### 2.9.9
- Email auto-inference from telemetry
- Automatically assign "Guest" for unknown active email
- Read-only email UI where inferred

### 2.9.8
- Fixed visual bug in ACTIONS column for the active account
- Added ACTIVE indicator for current account in dashboard
- UI improvements for table rendering

### 2.9.7
- Added ability to set and edit email for profiles
- Added `antigravity-switcher.setEmail` command
- UI improvements for profile management

### 2.9.6
- Internal refinements

### 2.6.7
- Increased max profiles to unlimited (2000+)

---

Made for bypassing rate limits without the hassle of manual re-login! 🚀
