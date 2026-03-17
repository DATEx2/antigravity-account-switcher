const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

/**
 * Antigravity Multi-Account Switcher
 * Final Version 2.8.0
 * 
 * Features:
 * - 5 colorful profile slot buttons for one-click account switching
 * - Save/Delete profile buttons
 * - Profile switching with automatic Antigravity restart
 * - Rate limit detection with auto-switch prompt
 * 
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Antigravity Account Switcher v2.8.0 is now active - Full workspace state persistence');

    const scriptPath = path.join(context.extensionPath, 'scripts', 'profile_manager.ps1');
    const NUM_SLOTS = 20;

    // Files for storage (in AppData/Antigravity)
    const ANTIGRAVITY_BASE_DIR = path.join(process.env.APPDATA || '', 'Antigravity');
    const ACTIVE_PROFILE_FILE = path.join(ANTIGRAVITY_BASE_DIR, 'active_profile.txt');
    const PENDING_STATE_FILE = path.join(ANTIGRAVITY_BASE_DIR, 'pending_state.json');
    const QUOTA_CACHE_FILE = path.join(ANTIGRAVITY_BASE_DIR, 'profiles_quota.json');

    /**
     * Quota Manager - Handles fetching and caching model quotas from Antigravity Language Server
     */
    class QuotaManager {
        constructor() {
            this.cache = this.loadCache();
            this.currentConnection = null;
            this.isFetching = false;
        }

        loadCache() {
            try {
                if (fs.existsSync(QUOTA_CACHE_FILE)) {
                    return JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf8'));
                }
            } catch (e) {
                console.error('Error loading quota cache:', e);
            }
            return {};
        }

        saveCache() {
            try {
                if (!fs.existsSync(ANTIGRAVITY_BASE_DIR)) {
                    fs.mkdirSync(ANTIGRAVITY_BASE_DIR, { recursive: true });
                }
                fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(this.cache, null, 2), 'utf8');
            } catch (e) {
                console.error('Error saving quota cache:', e);
            }
        }

        /**
         * Get the display prefix based on availability rules
         * 100% => all models at 100%
         * C60% => Claude at 60% (highest priority model available)
         * G90% => Gemini Pro at 90% (Claude exhausted)
         * F80% => Gemini Flash at 80% (Claude/Pro exhausted)
         */
        /**
         * Get the display prefix based on availability rules
         */
        getAvailabilityPrefix(profileName) {
            const data = this.cache[profileName];
            if (!data || !data.models || data.models.length === 0) return '';

            const models = data.models;
            const findModel = (keywords, exclude = []) => {
                return models.find(m => {
                    const n = (m.name || '').toLowerCase();
                    const l = (m.displayName || m.label || '').toLowerCase();
                    const matches = keywords.some(k => n.includes(k) || l.includes(k));
                    const excluded = exclude.some(e => n.includes(e) || l.includes(e));
                    return matches && !excluded;
                });
            };

            const claude = findModel(['claude']);
            const geminiPro = findModel(['pro'], ['flash']);
            const geminiFlash = findModel(['flash']);

            const allFull = models.every(m => m.remainingPercentage >= 95);
            if (allFull) return '100% ';

            if (claude && claude.remainingPercentage > 0) return `C${Math.round(claude.remainingPercentage)}% `;
            if (geminiPro && geminiPro.remainingPercentage > 0) return `G${Math.round(geminiPro.remainingPercentage)}% `;
            if (geminiFlash && geminiFlash.remainingPercentage > 0) return `F${Math.round(geminiFlash.remainingPercentage)}% `;
            
            return '0% ';
        }

        /**
         * Get full detailed prefix for active account
         */
        getFullAvailabilityPrefix(profileName) {
            const data = this.cache[profileName];
            if (!data || !data.models || data.models.length === 0) return 'no data ';

            const models = data.models;
            const allFull = models.every(m => m.remainingPercentage >= 98);
            if (allFull) return '100% ';

            const findModel = (keywords, exclude = []) => {
                return models.find(m => {
                    const n = (m.name || '').toLowerCase();
                    const l = (m.displayName || m.label || '').toLowerCase();
                    return keywords.some(k => n.includes(k) || l.includes(k)) && 
                           !exclude.some(e => n.includes(e) || l.includes(e));
                });
            };

            const claude = findModel(['claude']);
            const geminiPro = findModel(['pro'], ['flash']);
            const geminiFlash = findModel(['flash']);

            const format = (m, label) => {
                if (!m) return '';
                const pct = Math.round(m.remainingPercentage);
                return pct > 0 ? `${label}${pct}%` : '';
            };

            const c = format(claude, 'C');
            const g = format(geminiPro, 'G');
            const f = format(geminiFlash, 'F');
            
            const parts = [c, g, f].filter(p => p !== '');
            return parts.length > 0 ? parts.join(' | ') + ' ' : '';
        }

        /**
         * Get minimum availability percentage among tracked models for coloring
         */
        getMinAvailability(profileName) {
            const data = this.cache[profileName];
            if (!data || !data.models || data.models.length === 0) return 100;

            const tracked = data.models.filter(m => {
                const n = m.name.toLowerCase();
                const l = (m.displayName || '').toLowerCase();
                return n.includes('claude') || n.includes('pro') || n.includes('flash') ||
                       l.includes('claude') || l.includes('pro') || l.includes('flash');
            });
            
            if (tracked.length === 0) return 100;
            return Math.min(...tracked.map(m => m.remainingPercentage));
        }

        /**
         * Get overall availability score for sorting (0-100)
         */
        getAvailabilityScore(profileName) {
            const data = this.cache[profileName];
            if (!data || !data.models) return -1; // Unknown at the bottom

            const models = data.models;
            const findModel = (keywords, exclude = []) => {
                return models.find(m => {
                    const name = m.name.toLowerCase();
                    const label = (m.displayName || '').toLowerCase();
                    const matches = keywords.some(k => name.includes(k) || label.includes(k));
                    const excluded = exclude.some(e => name.includes(e) || label.includes(e));
                    return matches && !excluded;
                });
            };

            const claude = findModel(['claude']);
            const geminiPro = findModel(['pro'], ['flash']);
            const geminiFlash = findModel(['flash']);

            // Weighting: Claude > Gemini Pro > Gemini Flash
            if (claude && claude.remainingPercentage > 0) return 900 + claude.remainingPercentage;
            if (geminiPro && geminiPro.remainingPercentage > 0) return 600 + geminiPro.remainingPercentage;
            if (geminiFlash && geminiFlash.remainingPercentage > 0) return 300 + geminiFlash.remainingPercentage;
            
            return 0; // Exhausted
        }

        async detectConnection() {
            return new Promise((resolve) => {
                const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'name=''language_server_windows_x64.exe''' | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
                exec(cmd, (error, stdout) => {
                    if (error || !stdout) return resolve(null);
                    try {
                        let data = JSON.parse(stdout);
                        if (!Array.isArray(data)) data = [data];
                        
                        // Filter for the right process (antigravity app data dir)
                        // It must have csrf_token and app_data_dir antigravity
                        const proc = data.find(p => p.CommandLine && p.CommandLine.includes('--csrf_token') && p.CommandLine.toLowerCase().includes('antigravity'));
                        if (!proc) return resolve(null);

                        const tokenMatch = proc.CommandLine.match(/--csrf_token\s+([a-zA-Z0-9-]+)/i);
                        if (tokenMatch) {
                            const pid = proc.ProcessId;
                            const csrfToken = tokenMatch[1];

                            // Now find the listening port via netstat
                            exec(`netstat -ano | findstr "${pid}" | findstr "LISTENING"`, async (err, nsStdout) => {
                                if (err || !nsStdout) return resolve(null);
                                const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+\S+\s+LISTENING/gi;
                                let match;
                                const ports = [];
                                while ((match = portRegex.exec(nsStdout)) !== null) {
                                    ports.push(parseInt(match[1]));
                                }
                                
                                // Test each port with GetUserStatus to see which one answers
                                for (const port of ports.sort((a,b)=>a-b)) {
                                    const success = await this.pingPort(port, csrfToken);
                                    if (success) {
                                        return resolve({ port, csrfToken });
                                    }
                                }
                                resolve(null);
                            });
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
        }

        async pingPort(port, token) {
            return new Promise(resolve => {
                const data = JSON.stringify({
                    metadata: { ideName: 'antigravity', extensionName: 'antigravity-account-switcher', locale: 'en' }
                });
                const options = {
                    hostname: '127.0.0.1',
                    port,
                    path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Codeium-Csrf-Token': token,
                        'Connect-Protocol-Version': '1',
                    },
                    rejectUnauthorized: false,
                    timeout: 2000,
                };
                const req = https.request(options, res => resolve(res.statusCode === 200));
                req.on('error', () => resolve(false));
                req.on('timeout', () => { req.destroy(); resolve(false); });
                req.write(data);
                req.end();
            });
        }

        async fetchQuota() {
            if (this.isFetching) return;
            this.isFetching = true;

            try {
                const conn = await this.detectConnection();
                if (!conn) {
                    console.log('Antigravity connection not found');
                    this.isFetching = false;
                    return;
                }

                const data = JSON.stringify({
                    metadata: { ideName: 'antigravity', extensionName: 'antigravity-account-switcher', locale: 'en' }
                });

                const options = {
                    hostname: '127.0.0.1',
                    port: conn.port,
                    path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        'Connect-Protocol-Version': '1',
                        'X-Codeium-Csrf-Token': conn.csrfToken
                    },
                    rejectUnauthorized: false,
                    timeout: 5000
                };

                return new Promise((resolve) => {
                    const req = https.request(options, (res) => {
                        let body = '';
                        res.on('data', chunk => body += chunk);
                        res.on('end', () => {
                            this.isFetching = false;
                            if (res.statusCode === 200) {
                                try {
                                    const parsed = JSON.parse(body);
                                    const processed = this.processQuotaResponse(parsed);
                                    const activeProfile = getActiveProfile();
                                    if (activeProfile && processed) {
                                        this.cache[activeProfile] = processed;
                                        this.saveCache();
                                        resolve(processed);
                                    }
                                } catch (e) {
                                    console.error('Error parsing quota JSON:', e);
                                }
                            }
                            resolve(null);
                        });
                    });

                    req.on('error', (e) => {
                        this.isFetching = false;
                        console.error('Quota fetch error:', e);
                        resolve(null);
                    });
                    req.write(data);
                    req.end();
                });
            } catch (e) {
                this.isFetching = false;
                console.error('Unexpected error in fetchQuota:', e);
            }
        }

        processQuotaResponse(response) {
            if (!response || !response.userStatus) return null;
            const modelConfigs = response.userStatus.cascadeModelConfigData?.clientModelConfigs || [];
            const result = {
                timestamp: new Date().toISOString(),
                models: []
            };

            for (const config of modelConfigs) {
                const quotaInfo = config.quotaInfo;
                if (!quotaInfo) continue;

                const remainingFraction = quotaInfo.remainingFraction || 0;
                result.models.push({
                    name: config.modelOrAlias?.model || 'unknown',
                    displayName: config.label || config.modelOrAlias?.model || 'unknown',
                    remainingFraction: remainingFraction,
                    remainingPercentage: remainingFraction * 100,
                    resetTime: quotaInfo.resetTime ? new Date(quotaInfo.resetTime).toISOString() : null
                });
            }
            return result;
        }

        formatDelta(resetTimeStr, isShort = false) {
            if (!resetTimeStr) return 'Unknown';
            const ms = new Date(resetTimeStr).getTime() - Date.now();
            if (ms <= 0) return 'Ready';

            const seconds = Math.floor(ms / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);

            if (isShort) {
                if (days > 0) return `${(hours / 24).toFixed(1)}d`;
                if (hours > 0) return `${hours}h`;
                if (minutes > 0) return `${minutes}m`;
                return `${seconds}s`;
            }

            if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
            if (hours > 0) return `${hours}h ${minutes % 60}m`;
            if (minutes > 0) return `${minutes}m`;
            return `${seconds}s`;
        }

        buildTooltip(profileName) {
            const data = this.cache[profileName];
            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            md.supportHtml = true;

            const active = getActiveProfile();
            const isActive = active && active.toLowerCase() === profileName.toLowerCase();

            md.appendMarkdown(`### ${isActive ? '✅ ' : '👤 '}${profileName}\n\n`);

            if (!data || !data.models || data.models.length === 0) {
                md.appendMarkdown(`*No telemetry data for this account.*\n\n[ ⚡ Switch & Scan ](command:antigravity-switcher.switchAccountExplicit?${encodeURIComponent(JSON.stringify(profileName))})`);
                md.appendMarkdown(`\n\n---\n[ 📊 Dashboard ](command:antigravity-switcher.pinQuota)`);
                return md;
            }

            md.appendMarkdown(`| | Model | Quota | Reset |\n`);
            md.appendMarkdown(`| :--- | :--- | :--- | :--- |\n`);

            for (const model of data.models) {
                const pct = Math.round(model.remainingPercentage);
                const color = pct >= 50 ? '🟢' : (pct >= 20 ? '🟡' : '🔴');
                
                // Progress bar with squares in a table for perfect alignment
                const filled = Math.round(pct / 10);
                const bar = '🟩'.repeat(filled) + '⬛'.repeat(10 - filled);
                
                md.appendMarkdown(`| ${color} | **${model.displayName}** | ${bar} **${pct}%** | *${this.formatDelta(model.resetTime, false)}* |\n`);
            }

            const lastUpdated = new Date(data.timestamp).toLocaleString();
            md.appendMarkdown(`---\n*Last sync: ${lastUpdated}*\n\n[ 📊 Open Dashboard ](command:antigravity-switcher.pinQuota)`);
            return md;
        }
    }

    /**
     * Dashboard View (Persistent Webview with Tabs)
     */
    class QuotaDashboard {
        constructor() { 
            this.panel = null; 
            this.selectedProfile = null;
            this.deleteMode = false;
        }

        async show(mgr, profile = null) {
            if (profile) {
                this.selectedProfile = profile;
            }
            if (this.panel) {
                this.panel.reveal(vscode.ViewColumn.Two);
                await this.update(mgr);
                return;
            }

            this.panel = vscode.window.createWebviewPanel(
                'antigravityQuota',
                'Antigravity Quota Dashboard',
                vscode.ViewColumn.Two,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            this.panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.command === 'selectProfile') {
                    this.selectedProfile = msg.profile;
                    await this.update(mgr);
                } else if (msg.command === 'switchAccount') {
                    const confirm = await vscode.window.showInformationMessage(`Switch to account "${msg.profile}"? Antigravity will restart.`, { modal: true }, 'Switch');
                    if (confirm === 'Switch') {
                        saveFullWorkspaceState();
                        setActiveProfile(msg.profile);
                        await runProfileManager('Load', msg.profile);
                    }
                } else if (msg.command === 'addAccount') {
                    vscode.commands.executeCommand('antigravity-switcher.saveProfile');
                } else if (msg.command === 'toggleDeleteMode') {
                    this.deleteMode = !this.deleteMode;
                    await this.update(mgr);
                } else if (msg.command === 'deleteAccount') {
                    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to PERMANENTLY delete profile "${msg.profile}"?`, { modal: true }, 'Delete');
                    if (confirm === 'Delete') {
                        await runProfileManager('Delete', msg.profile);
                        if (this.selectedProfile === msg.profile) {
                            this.selectedProfile = 'Dashboard';
                        }
                        clearProfilesCache();
                        updateProfileButtons();
                        await this.update(mgr);
                    }
                } else if (msg.command === 'renameAccount') {
                    const result = await vscode.commands.executeCommand('antigravity-switcher.renameProfile', msg.profile);
                    if (result && result.success && result.newName) {
                        this.selectedProfile = result.newName;
                        await this.update(mgr);
                    }
                } else if (msg.command === 'editEmail') {
                    await vscode.commands.executeCommand('antigravity-switcher.setEmail', msg.profile);
                    await this.update(mgr);
                }
            });

            this.panel.onDidDispose(() => { this.panel = null; });
            await this.update(mgr);
        }

        async update(mgr) {
            if (!this.panel) return;
            const profiles = await getProfiles();
            const active = getActiveProfile();
            
            if (!this.selectedProfile) {
                this.selectedProfile = 'Dashboard';
            }

            const profileData = mgr.cache[this.selectedProfile];
            const isActiveProfile = active && this.selectedProfile && active.toLowerCase() === this.selectedProfile.toLowerCase();

            let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        background: #1a1b26; 
                        color: #a9b1d6; 
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        padding: 0; 
                        margin: 0;
                        height: 100vh;
                        display: flex;
                        flex-direction: column;
                    }
                    .tabs {
                        display: flex;
                        background: #16161e;
                        padding: 10px 20px 0 20px;
                        border-bottom: 1px solid #414868;
                        gap: 2px;
                        overflow-x: auto;
                    }
                    .tab {
                        padding: 10px 18px;
                        background: #24283b;
                        color: #565f89;
                        border-radius: 6px 6px 0 0;
                        cursor: pointer;
                        font-weight: 500;
                        transition: all 0.2s;
                        white-space: nowrap;
                        font-size: 0.9rem;
                        border: 1px solid transparent;
                        border-bottom: none;
                    }
                    .tab:hover {
                        color: #c0caf5;
                        background: #2f334d;
                    }
                    .tab.selected {
                        background: #1a1b26;
                        color: #ffffff;
                        border-color: #414868;
                        position: relative;
                        bottom: -1px;
                        z-index: 10;
                    }
                    .active-indicator {
                        display: inline-block;
                        width: 8px;
                        height: 8px;
                        background: #22c55e;
                        border-radius: 50%;
                        margin-right: 8px;
                        box-shadow: 0 0 5px #22c55e;
                    }
                    .content {
                        flex: 1;
                        padding: 30px;
                        overflow-y: auto;
                    }
                    h2 { 
                        color: #ffffff; 
                        font-size: 1.6rem; 
                        margin: 0 0 30px 0; 
                        display: flex;
                        align-items: center;
                        gap: 12px;
                    }
                    .model-row { margin-bottom: 25px; }
                    .header { 
                        display: flex; 
                        justify-content: space-between; 
                        align-items: flex-end;
                        margin-bottom: 8px;
                    }
                    .model-name { font-weight: 500; font-size: 1.1rem; color: #c0caf5; }
                    .percentage { font-weight: 600; font-size: 1.1rem; color: #ffffff; }
                    .bar-container { 
                        height: 6px; 
                        background: #24283b; 
                        border-radius: 3px; 
                        overflow: hidden;
                        margin-bottom: 6px;
                    }
                    .bar { 
                        height: 100%; 
                        transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
                        border-radius: 3px;
                    }
                    .reset-text { font-size: 0.85rem; color: #565f89; }
                    .actions {
                        margin-top: 40px;
                        padding-top: 20px;
                        border-top: 1px solid #24283b;
                    }
                    .switch-btn {
                        background: #3d59a1;
                        color: white;
                        border: none;
                        padding: 12px 28px;
                        border-radius: 6px;
                        font-weight: 600;
                        cursor: pointer;
                        font-size: 1rem;
                        transition: all 0.2s;
                    }
                    .switch-btn:hover {
                        background: #4e6bbd;
                        transform: translateY(-1px);
                        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                    }
                    .active-badge {
                        background: #1c3426;
                        color: #22c55e;
                        font-size: 0.8rem;
                        padding: 4px 10px;
                        border-radius: 12px;
                        font-weight: 600;
                        text-transform: uppercase;
                    }
                    /* DASHBOARD TABLE STYLES */
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        margin-top: 20px;
                        background: #1a1b26;
                    }
                    th {
                        text-align: left;
                        padding: 12px 15px;
                        color: #565f89;
                        font-weight: 600;
                        text-transform: uppercase;
                        font-size: 0.75rem;
                        border-bottom: 1px solid #24283b;
                        letter-spacing: 0.05em;
                    }
                    td {
                        padding: 12px 15px;
                        border-bottom: 1px solid #24283b;
                        color: #c0caf5;
                        font-size: 0.95rem;
                        vertical-align: middle;
                    }
                    tr:hover td {
                        background: #16161e;
                    }
                    .pct-cell {
                        font-weight: 600;
                        width: 80px;
                    }
                    .time-cell {
                        color: #9ece6a;
                        width: 150px;
                    }
                    .status-dot {
                        display: inline-block;
                        width: 10px;
                        height: 10px;
                        border-radius: 50%;
                        margin-right: 10px;
                    }
                    tr.row-active td {
                        background: #1e2237;
                    }
                    tr.row-active td:first-child {
                        box-shadow: inset 3px 0 0 #7aa2f7;
                    }
                    .editable-title:hover {
                        color: #7aa2f7;
                        border-bottom-color: #7aa2f7;
                    }
                    .editable-email {
                        font-size: 0.75rem;
                        color: #565f89;
                        cursor: pointer;
                        display: inline-block;
                        border-bottom: 1px dashed transparent;
                        transition: all 0.2s;
                    }
                    .editable-email:hover {
                        color: #7aa2f7;
                        border-bottom-color: #7aa2f7;
                    }
                    .btn-icon {
                        background: #24283b;
                        color: #c0caf5;
                        border: 1px solid #414868;
                        width: 32px;
                        height: 32px;
                        border-radius: 4px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 1.2rem;
                        transition: all 0.2s;
                    }
                    .btn-icon:hover {
                        background: #3d59a1;
                        color: #fff;
                    }
                    .btn-icon.active {
                        background: #ef4444;
                        color: #fff;
                        border-color: #ef4444;
                    }
                    .header-actions {
                        display: flex;
                        gap: 10px;
                        margin-bottom: 20px;
                    }
                    .inline-switch-btn {
                        background: #3d59a1;
                        color: white;
                        border: none;
                        padding: 6px 12px;
                        border-radius: 4px;
                        font-size: 0.8rem;
                        cursor: pointer;
                        white-space: nowrap;
                    }
                    .inline-switch-btn:hover {
                        background: #4e6bbd;
                    }
                    .remove-btn {
                        background: #ef444422;
                        color: #ef4444;
                        border: 1px solid #ef444444;
                        padding: 6px 12px;
                        border-radius: 4px;
                        font-size: 0.8rem;
                        cursor: pointer;
                        margin-left: 10px;
                    }
                    .remove-btn:hover {
                        background: #ef4444;
                        color: white;
                    }
                    .actions-cell {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        justify-content: flex-end;
                    }
                </style>
            </head>
            <body>
                <div class="tabs">
                    <div class="tab ${this.selectedProfile === 'Dashboard' ? 'selected' : ''}" onclick="selectTab('Dashboard')">
                        📊 Dashboard
                    </div>
                    ${profiles
                        .map(p => ({ 
                            name: p.Name || p.name, 
                            score: mgr.getAvailabilityScore(p.Name || p.name) 
                        }))
                        .sort((a, b) => b.score - a.score)
                        .map(p => {
                            const pName = p.name;
                            const isCurrent = active && active.toLowerCase() === pName.toLowerCase();
                            const isSelected = this.selectedProfile && this.selectedProfile.toLowerCase() === pName.toLowerCase();
                            return `<div class="tab ${isSelected ? 'selected' : ''}" onclick="selectTab('${pName}')">
                                ${isCurrent ? '<span class="active-indicator"></span>' : ''} ${pName}
                            </div>`;
                        }).join('')}
                </div>
                <div class="content">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px;">
                        <h2 style="margin: 0">
                            ${this.selectedProfile === 'Dashboard' ? 'Accounts Overview' : 
                                `<span class="editable-title" title="Click to rename" onclick="renameAccount('${this.selectedProfile}')">${this.selectedProfile}</span>`}
                            ${isActiveProfile ? '<span class="active-badge">Currently Active</span>' : ''}
                        </h2>
                        <div class="header-actions">
                            <button class="btn-icon" title="Add Account" onclick="addAccount()">+</button>
                            <button class="btn-icon ${this.deleteMode ? 'active' : ''}" title="Toggle Remove Mode" onclick="toggleDeleteMode()">-</button>
                        </div>
                    </div>
            `;

            if (this.selectedProfile === 'Dashboard') {
                // RENDER DASHBOARD TAB (Aggregation)
                const stats = profiles.map(p => {
                    const name = p.Name || p.name;
                    const data = mgr.cache[name];
                    const isActive = active && name.toLowerCase() === active.toLowerCase();
                    
                    let overallPct = 0;
                    let nextReset = Infinity;
                    let nextResetStr = 'Ready';
                    
                    if (data && data.models && data.models.length > 0) {
                        const modelsToAvg = data.models;
                        overallPct = modelsToAvg.reduce((sum, m) => sum + (m.remainingPercentage || 0), 0) / modelsToAvg.length;
                        
                        const resetable = data.models.filter(m => m.resetTime && m.remainingPercentage < 98);
                        if (resetable.length > 0) {
                            const times = resetable.map(m => new Date(m.resetTime).getTime());
                            nextReset = Math.min(...times);
                            const now = Date.now();
                            if (nextReset > now) {
                                nextResetStr = mgr.formatDelta(new Date(nextReset).toISOString(), false);
                            } else {
                                nextResetStr = 'Ready';
                            }
                        } else {
                            nextResetStr = overallPct >= 95 ? 'Full' : 'Ready';
                        }
                    }
                    
                    return { name, email: p.Email || '', overallPct, nextReset, nextResetStr, isActive };
                });
                
                // Sort by Overall % (Descending) then Next Reset (Ascending)
                stats.sort((a, b) => {
                    const pctDiff = Math.round(b.overallPct) - Math.round(a.overallPct);
                    if (pctDiff !== 0) return pctDiff;
                    return a.nextReset - b.nextReset;
                });
                
                html += `
                <table>
                    <thead>
                        <tr>
                            <th>Account Name</th>
                            <th>Status</th>
                            <th>Overall %</th>
                            <th>Next Reset</th>
                            <th style="text-align: right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${stats.map(s => {
                            const color = s.overallPct > 50 ? '#22c55e' : (s.overallPct > 20 ? '#eab308' : '#ef4444');
                            return `
                            <tr class="${s.isActive ? 'row-active' : ''}" onclick="if(!event.target.closest('button')) selectTab('${s.name}')" style="cursor:pointer">
                                <td>
                                    ${s.isActive ? '<span class="status-dot" style="background:#22c55e; box-shadow:0 0 5px #22c55e"></span>' : '<span class="status-dot" style="background:#414868"></span>'}
                                    <div style="display:inline-block; vertical-align:middle">
                                        <div style="${s.isActive ? 'font-weight:bold; color:#ffffff' : ''}">${s.name}</div>
                                        <div class="editable-email" title="Click to edit email" onclick="editEmail('${s.name}')">
                                            ${s.email || 'No email set'}
                                        </div>
                                    </div>
                                </td>
                                <td>${s.isActive ? '<span style="color:#7aa2f7; font-size:0.8rem">ACTIVE</span>' : ''}</td>
                                <td class="pct-cell" style="color:${color}">${Math.round(s.overallPct)}%</td>
                                <td class="time-cell">${s.nextResetStr === 'Full' ? '<span style="color:#565f89">Available</span>' : (s.nextResetStr === 'Ready' ? '<span style="color:#7aa2f7">Ready</span>' : s.nextResetStr)}</td>
                                <td class="actions-cell">
                                    ${!s.isActive ? `<button class="inline-switch-btn" onclick="switchAccount('${s.name}')">Switch</button>` : ''}
                                    ${this.deleteMode ? `<button class="remove-btn" onclick="deleteAccount('${s.name}')">Remove</button>` : ''}
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
                `;
            } else if (profileData && profileData.models) {
                // NEW: Priority Sorting (Request 9)
                const getPriority = (m) => {
                    const n = (m.displayName || m.name || '').toLowerCase();
                    if (n.includes('flash')) return 1;
                    if (n.includes('pro') && n.includes('low')) return 2;
                    if (n.includes('pro') && (n.includes('high') || !n.includes('low'))) return 3;
                    if (n.includes('sonnet')) return 4;
                    if (n.includes('opus')) return 5;
                    if (n.includes('gpt')) return 6;
                    return 10;
                };

                const sortedModels = [...profileData.models].sort((a, b) => getPriority(a) - getPriority(b));
                for (const m of sortedModels) {
                    const pct = Math.round(m.remainingPercentage);
                    const color = pct > 50 ? '#22c55e' : (pct > 20 ? '#eab308' : '#ef4444');
                    html += `
                    <div class="model-row">
                        <div class="header">
                            <span class="model-name">${m.displayName}</span>
                            <span class="percentage">${pct}%</span>
                        </div>
                        <div class="bar-container">
                            <div class="bar" style="width: ${pct}%; background: ${color}; box-shadow: 0 0 10px ${color}44;"></div>
                        </div>
                        <div class="reset-text">Resets in: ${mgr.formatDelta(m.resetTime, false)}</div>
                    </div>`;
                }
            } else {
                html += '<p style="text-align:center; padding: 60px; color: #565f89; border: 1px dashed #24283b; border-radius: 12px;">No telemetry data available for this account.<br><br>Switch to it and perform a scan to collect details.</p>';
            }

            if (!isActiveProfile && this.selectedProfile && this.selectedProfile !== 'Dashboard') {
                html += `
                <div class="actions">
                    <button class="switch-btn" onclick="switchAccount('${this.selectedProfile}')">🚀 Switch to this Account</button>
                </div>`;
            }

            html += `
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    function selectTab(name) {
                        vscode.postMessage({ command: 'selectProfile', profile: name });
                    }
                    function switchAccount(name) {
                        vscode.postMessage({ command: 'switchAccount', profile: name });
                    }
                    function addAccount() {
                        vscode.postMessage({ command: 'addAccount' });
                    }
                    function toggleDeleteMode() {
                        vscode.postMessage({ command: 'toggleDeleteMode' });
                    }
                    function deleteAccount(name) {
                        vscode.postMessage({ command: 'deleteAccount', profile: name });
                    }
                    function editEmail(name) {
                        vscode.postMessage({ command: 'editEmail', profile: name });
                    }
                    function renameAccount(name) {
                        vscode.postMessage({ command: 'renameAccount', profile: name });
                    }
                </script>
            </body>
            </html>
            `;
            this.panel.webview.html = html;
        }
    }
    const quotaDashboard = new QuotaDashboard();

    const quotaManager = new QuotaManager();

    /**
     * Get the currently active profile name from shared file
     */
    function getActiveProfile() {
        try {
            if (fs.existsSync(ACTIVE_PROFILE_FILE)) {
                return fs.readFileSync(ACTIVE_PROFILE_FILE, 'utf8').trim();
            }
        } catch (e) {
            console.error('Error reading active profile:', e);
        }
        return null;
    }

    /**
     * Set the active profile name in shared file
     */
    function setActiveProfile(profileName) {
        try {
            const dir = path.dirname(ACTIVE_PROFILE_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(ACTIVE_PROFILE_FILE, profileName, 'utf8');
            return true;
        } catch (e) {
            console.error('Error saving active profile:', e);
            return false;
        }
    }

    /**
     * Save full workspace state (folders, editors, layout) for restoration after profile switch
     */
    function saveFullWorkspaceState() {
        try {
            const state = {
                version: 1,
                timestamp: new Date().toISOString(),
                workspaceFolders: [],
                openEditors: [],
                activeEditorUri: null
            };

            // Save all workspace folders
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                state.workspaceFolders = workspaceFolders.map(f => f.uri.fsPath);
            }

            // Save all open editors using tabGroups API (VS Code 1.67+)
            if (vscode.window.tabGroups) {
                const tabGroups = vscode.window.tabGroups;
                for (const group of tabGroups.all) {
                    for (const tab of group.tabs) {
                        if (tab.input && tab.input.uri) {
                            state.openEditors.push({
                                uri: tab.input.uri.toString(),
                                viewColumn: group.viewColumn || 1,
                                isActive: tabGroups.activeTabGroup === group && group.activeTab === tab
                            });
                        }
                    }
                }
                // Track active editor
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    state.activeEditorUri = activeEditor.document.uri.toString();
                }
            }

            // Write state to file
            const dir = path.dirname(PENDING_STATE_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(PENDING_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
            console.log('Saved full workspace state:', state.workspaceFolders.length, 'folders,', state.openEditors.length, 'editors');
            return true;
        } catch (e) {
            console.error('Error saving workspace state:', e);
        }
        return false;
    }

    /**
     * Get and clear pending workspace state
     */
    function getPendingWorkspaceState() {
        try {
            if (fs.existsSync(PENDING_STATE_FILE)) {
                const stateJson = fs.readFileSync(PENDING_STATE_FILE, 'utf8');
                const state = JSON.parse(stateJson);
                // Clear the file after reading
                fs.unlinkSync(PENDING_STATE_FILE);
                return state;
            }
        } catch (e) {
            console.error('Error reading pending state:', e);
        }
        return null;
    }

    /**
     * Restore all editors from saved state
     */
    async function restoreEditors(state) {
        if (!state || !state.openEditors || state.openEditors.length === 0) {
            return;
        }

        console.log('Restoring', state.openEditors.length, 'editors...');

        // Group editors by viewColumn
        const editorsByColumn = {};
        for (const editor of state.openEditors) {
            const col = editor.viewColumn || 1;
            if (!editorsByColumn[col]) {
                editorsByColumn[col] = [];
            }
            editorsByColumn[col].push(editor);
        }

        // Open editors in each column
        for (const [column, editors] of Object.entries(editorsByColumn)) {
            for (const editor of editors) {
                try {
                    const uri = vscode.Uri.parse(editor.uri);
                    if (fs.existsSync(uri.fsPath)) {
                        await vscode.window.showTextDocument(uri, {
                            viewColumn: parseInt(column),
                            preview: false,
                            preserveFocus: !editor.isActive
                        });
                    }
                } catch (e) {
                    console.log('Could not restore editor:', editor.uri, e.message);
                }
            }
        }

        // Focus the active editor if specified
        if (state.activeEditorUri) {
            try {
                const uri = vscode.Uri.parse(state.activeEditorUri);
                if (fs.existsSync(uri.fsPath)) {
                    await vscode.window.showTextDocument(uri, { preview: false });
                }
            } catch (e) {
                console.log('Could not focus active editor:', e.message);
            }
        }
    }

    // ============================================
    // FULL WORKSPACE RESTORATION ON STARTUP
    // ============================================
    const pendingState = getPendingWorkspaceState();
    if (pendingState) {
        // Restore workspace folders first
        if (pendingState.workspaceFolders && pendingState.workspaceFolders.length > 0) {
            const firstFolder = pendingState.workspaceFolders[0];
            const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            if (currentWorkspace !== firstFolder && fs.existsSync(firstFolder)) {
                console.log('Restoring workspace folders...');

                // If multiple folders, we need to handle multi-root workspace
                if (pendingState.workspaceFolders.length > 1) {
                    // Add all folders as multi-root workspace
                    const foldersToAdd = pendingState.workspaceFolders
                        .filter(f => fs.existsSync(f))
                        .map(f => ({ uri: vscode.Uri.file(f) }));

                    if (foldersToAdd.length > 0) {
                        // Open first folder, then add the rest
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(firstFolder), false).then(() => {
                            // Schedule adding remaining folders and editor restoration
                            setTimeout(() => {
                                if (foldersToAdd.length > 1) {
                                    vscode.workspace.updateWorkspaceFolders(1, 0, ...foldersToAdd.slice(1));
                                }
                                // Restore editors after folders are set up
                                restoreEditors(pendingState);
                            }, 2000);
                        });

                        vscode.window.showInformationMessage(
                            `Restored ${foldersToAdd.length} workspace folders and ${pendingState.openEditors?.length || 0} editors`
                        );
                    }
                } else {
                    // Single folder - just open it and restore editors
                    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(firstFolder), false).then(() => {
                        setTimeout(() => restoreEditors(pendingState), 2000);
                    });
                    vscode.window.showInformationMessage(`Restored workspace: ${path.basename(firstFolder)}`);
                }
            } else if (currentWorkspace === firstFolder) {
                // Already in correct workspace, just restore editors
                restoreEditors(pendingState);
            }
        } else if (pendingState.openEditors && pendingState.openEditors.length > 0) {
            // No workspace folders but have editors - just restore them
            restoreEditors(pendingState);
        }
    }

    // Colorful slot colors
    const SLOT_COLORS = [
        '#4CAF50', // Green
        '#FF9800', // Orange
        '#E65100', // Dark Orange
        '#BA68C8', // Purple
        '#F06292'  // Pink
    ];

    // Rate limit error patterns to monitor (Gemini + Claude)
    const RATE_LIMIT_PATTERNS = [
        // Google/Gemini patterns
        'rate limit', 'quota exceeded', 'too many requests', 'limit reached',
        'resource exhausted', '429', 'RESOURCE_EXHAUSTED',
        // Claude/Anthropic patterns
        'overloaded', 'capacity', 'rate_limit_error', 'overloaded_error',
        'api_error', 'Request limit', 'usage limit',
        'model is currently overloaded', 'temporarily unavailable'
    ];

    // Rate limit detection cooldown (1 minute)
    const RATE_LIMIT_COOLDOWN = 60000;
    let lastRateLimitAlert = 0;

    /**
     * Execute PowerShell script with given arguments
     */
    function runProfileManager(action, profileName = '', newProfileName = '', email = '') {
        return new Promise((resolve) => {
            const config = vscode.workspace.getConfiguration('antigravitySwitcher');
            const maxProfiles = config.get('maxProfiles', 20);
            
            let args = `-Action ${action} -MaxProfiles ${maxProfiles}`;
            if (profileName) {
                args += ` -ProfileName "${profileName}"`;
            }
            if (newProfileName) {
                args += ` -NewProfileName "${newProfileName}"`;
            }
            if (email) {
                args += ` -Email "${email}"`;
            }
            
            const command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" ${args}`;
            
            exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, output: stdout, error: stderr || error.message });
                } else {
                    resolve({ success: true, output: stdout, error: null });
                }
            });
        });
    }

    /**
     * Get list of saved profiles (Cached)
     */
    let profilesCache = null;
    let lastProfilesFetch = 0;
    const PROFILES_CACHE_TTL = 30000; // 30 seconds

    async function getProfiles(force = false) {
        const now = Date.now();
        if (!force && profilesCache && (now - lastProfilesFetch < PROFILES_CACHE_TTL)) {
            return profilesCache;
        }

        const result = await runProfileManager('List');
        try {
            const match = result.output.match(/\[[\s\S]*?\]/);
            if (match) {
                const profiles = JSON.parse(match[0]);
                profilesCache = Array.isArray(profiles) ? profiles : [];
                lastProfilesFetch = now;
                return profilesCache;
            }
        } catch (e) {
            console.error('Error parsing profiles:', e);
        }
        return profilesCache || [];
    }

    function clearProfilesCache() {
        profilesCache = null;
        lastProfilesFetch = 0;
    }

    /**
     * Check if text contains rate limit patterns
     */
    function containsRateLimitError(text) {
        const lowerText = text.toLowerCase();
        return RATE_LIMIT_PATTERNS.some(pattern => lowerText.includes(pattern.toLowerCase()));
    }

    /**
     * Handle rate limit detection - prompt user to switch accounts
     */
    async function handleRateLimitDetected() {
        const now = Date.now();
        if (now - lastRateLimitAlert < RATE_LIMIT_COOLDOWN) {
            return; // Still in cooldown
        }
        lastRateLimitAlert = now;

        const profiles = await getProfiles();
        if (profiles.length === 0) {
            vscode.window.showWarningMessage(
                '⚠️ Rate limit detected! Save some profiles to quickly switch accounts.'
            );
            return;
        }

        // Build quick switch options
        const items = profiles.map(p => ({
            label: `$(account) Switch to ${p.Name || p.name}`,
            profileName: p.Name || p.name
        }));
        items.push({ label: '$(x) Dismiss', profileName: null });

        const selected = await vscode.window.showWarningMessage(
            '⚠️ Rate limit detected! Switch to another account?',
            ...profiles.map(p => p.Name || p.name),
            'Dismiss'
        );

        if (selected && selected !== 'Dismiss') {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Switching to "${selected}"...`,
                cancellable: false
            }, async () => {
                await runProfileManager('Load', selected);
            });
        }
    }

    // ============================================
    // RATE LIMIT MONITORING
    // ============================================

    // Monitor diagnostic messages for rate limit errors
    const diagnosticListener = vscode.languages.onDidChangeDiagnostics((e) => {
        for (const uri of e.uris) {
            const diagnostics = vscode.languages.getDiagnostics(uri);
            for (const diag of diagnostics) {
                if (containsRateLimitError(diag.message)) {
                    handleRateLimitDetected();
                    return;
                }
            }
        }
    });
    context.subscriptions.push(diagnosticListener);

    // Monitor log file for rate limit errors (poll every 30 seconds)
    let lastLogSize = 0;
    const logCheckInterval = setInterval(async () => {
        try {
            const logsDir = path.join(process.env.APPDATA || '', 'Antigravity', 'logs');
            if (!fs.existsSync(logsDir)) return;

            // Find most recent log directory
            const logDirs = fs.readdirSync(logsDir)
                .filter(f => fs.statSync(path.join(logsDir, f)).isDirectory())
                .sort()
                .reverse();

            if (logDirs.length === 0) return;

            const mainLog = path.join(logsDir, logDirs[0], 'main.log');
            if (!fs.existsSync(mainLog)) return;

            const stats = fs.statSync(mainLog);
            if (stats.size <= lastLogSize) return;

            // Read new content
            const fd = fs.openSync(mainLog, 'r');
            const buffer = Buffer.alloc(Math.min(stats.size - lastLogSize, 10000));
            fs.readSync(fd, buffer, 0, buffer.length, lastLogSize);
            fs.closeSync(fd);
            lastLogSize = stats.size;

            const newContent = buffer.toString('utf8');
            if (containsRateLimitError(newContent)) {
                handleRateLimitDetected();
            }
        } catch (e) {
            // Ignore log reading errors
        }
    }, 30000); // Check every 30 seconds

    context.subscriptions.push({ dispose: () => clearInterval(logCheckInterval) });

    // ============================================
    // STATUS BAR BUTTONS (REFRESH + TOP 3 + >)
    // ============================================
    const MAX_VISIBLE_SLOTS = 3;
    
    // Refresh button (moved to more menu later, but hiding for now)
    const refreshButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1010);
    refreshButton.text = '$(refresh)';
    refreshButton.tooltip = 'Refresh Quota Data';
    refreshButton.command = 'antigravity-switcher.refreshQuota';
    context.subscriptions.push(refreshButton);
    // refreshButton.show(); // User wants it in the ">" menu

    const profileButtons = [];
    for (let i = 0; i < MAX_VISIBLE_SLOTS; i++) {
        const btn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000 - i);
        btn.command = `antigravity-switcher.slotAction${i}`;
        profileButtons.push(btn);
        context.subscriptions.push(btn);
    }

    // ">" button for remaining profiles + tools
    const moreButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000 - MAX_VISIBLE_SLOTS);
    moreButton.text = '>';
    moreButton.tooltip = 'Settings & More Profiles';
    moreButton.command = 'antigravity-switcher.moreMenu';
    context.subscriptions.push(moreButton);

    // Save button (+ icon)
    const saveButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 500);
    saveButton.text = '$(add)';
    saveButton.tooltip = 'Save current session as a new profile';
    saveButton.command = 'antigravity-switcher.saveProfile';
    context.subscriptions.push(saveButton);

    // Delete button (trash icon)
    const deleteButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 499);
    deleteButton.text = '$(trash)';
    deleteButton.tooltip = 'Delete a profile';
    deleteButton.command = 'antigravity-switcher.deleteProfile';
    context.subscriptions.push(deleteButton);

    let displayProfiles = [];

    /**
     * Update all profile buttons based on current profiles and availability
     */
    async function updateProfileButtons() {
        const profiles = await getProfiles();
        const activeProfileName = getActiveProfile();
        
        // Split active from inactive
        const activeProfile = profiles.find(p => {
            const name = p.Name || p.name;
            return activeProfileName && activeProfileName.toLowerCase() === name.toLowerCase();
        });
        
        const otherProfiles = profiles.filter(p => p !== activeProfile);
        
        // Sort other profiles by availability score
        otherProfiles.sort((a, b) => {
            const scoreA = quotaManager.getAvailabilityScore(a.Name || a.name);
            const scoreB = quotaManager.getAvailabilityScore(b.Name || b.name);
            return scoreB - scoreA;
        });

        // Current account first, then sorted others
        displayProfiles = [];
        if (activeProfile) displayProfiles.push(activeProfile);
        displayProfiles = displayProfiles.concat(otherProfiles);

        // Update slots
        for (let i = 0; i < MAX_VISIBLE_SLOTS; i++) {
            const btn = profileButtons[i];
            const profile = displayProfiles[i];

            if (profile) {
                const name = profile.Name || profile.name;
                const isActive = activeProfileName && activeProfileName.toLowerCase() === name.toLowerCase();
                const cachedData = quotaManager.cache[name];
                
                // Content display
                if (isActive) {
                    const fullPrefix = quotaManager.getFullAvailabilityPrefix(name);
                    
                    // Logic for reset time (Request 8)
                    let resetSuffix = '';
                    if (cachedData && cachedData.models) {
                        const nonFlashModels = cachedData.models.filter(m => !m.name.toLowerCase().includes('flash') && m.resetTime);
                        if (nonFlashModels.length > 0) {
                            const times = nonFlashModels.map(m => new Date(m.resetTime).getTime());
                            const minTime = Math.min(...times);
                            const delta = quotaManager.formatDelta(new Date(minTime).toISOString(), true);
                            if (delta !== 'Ready' && delta !== 'Unknown') {
                                resetSuffix = ` ${delta}`;
                            }
                        }
                    }
                    
                    btn.text = `$(check) ${fullPrefix}${name}${resetSuffix}`;
                    
                    // Logic for current user's color (Request 4)
                    if (cachedData && cachedData.models && cachedData.models.length > 0) {
                        const allZero = cachedData.models.every(m => Math.round(m.remainingPercentage) === 0);
                        const allBelow20 = cachedData.models.every(m => Math.round(m.remainingPercentage) < 20);
                        
                        if (allZero) {
                            btn.color = '#ff4d4d'; // Red
                        } else if (allBelow20) {
                            btn.color = '#FF9800'; // Orange
                        } else {
                            btn.color = SLOT_COLORS[0]; // Green (Request 2)
                        }
                    } else {
                        btn.color = SLOT_COLORS[i % SLOT_COLORS.length];
                    }
                } else {
                    const prefix = quotaManager.getAvailabilityPrefix(name);
                    
                    // Logic for reset time even for inactive slots
                    let resetSuffix = '';
                    if (cachedData && cachedData.models) {
                        const nonFlashModels = cachedData.models.filter(m => !m.name.toLowerCase().includes('flash') && m.resetTime);
                        if (nonFlashModels.length > 0) {
                            const times = nonFlashModels.map(m => new Date(m.resetTime).getTime());
                            const minTime = Math.min(...times);
                            const delta = quotaManager.formatDelta(new Date(minTime).toISOString(), true);
                            if (delta !== 'Ready' && delta !== 'Unknown') {
                                resetSuffix = ` ${delta}`;
                            }
                        }
                    }

                    btn.text = `$(account) ${prefix}${name}${resetSuffix}`;
                    btn.color = SLOT_COLORS[i % SLOT_COLORS.length];
                }

                // Background coloring logic
                if (cachedData && cachedData.models && cachedData.models.length > 0) {
                    const maxPct = Math.max(...cachedData.models.map(m => m.remainingPercentage || 0));
                    if (maxPct >= 40) {
                        btn.backgroundColor = undefined;
                    } else if (maxPct > 0) {
                        btn.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    } else {
                        btn.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    }
                } else {
                    btn.backgroundColor = undefined;
                }

                btn.tooltip = quotaManager.buildTooltip(name);
                btn.show();
            } else {
                btn.hide();
            }
        }

        // Handle ">" button
        if (displayProfiles.length > MAX_VISIBLE_SLOTS) {
            moreButton.show();
        } else {
            moreButton.hide();
        }

        saveButton.show();
        deleteButton.show();
    }

    // Register slot action commands
    for (let i = 0; i < MAX_VISIBLE_SLOTS; i++) {
        const slotIdx = i;
        const cmd = vscode.commands.registerCommand(`antigravity-switcher.slotAction${i}`, async () => {
            const profile = displayProfiles[slotIdx];
            if (profile) {
                const profileName = (profile.Name || profile.name);
                quotaDashboard.show(quotaManager, profileName);
            }
        });
        context.subscriptions.push(cmd);
    }

    // Register refresh command
    const refreshCmd = vscode.commands.registerCommand('antigravity-switcher.refreshQuota', async () => {
        refreshButton.text = '$(sync~spin)';
        await quotaManager.fetchQuota();
        updateProfileButtons();
        quotaDashboard.update(quotaManager);
        refreshButton.text = '$(refresh)';
    });
    context.subscriptions.push(refreshCmd);

    // Register Pin Dashboard command
    const pinCmd = vscode.commands.registerCommand('antigravity-switcher.pinQuota', () => {
        quotaDashboard.show(quotaManager);
    });
    context.subscriptions.push(pinCmd);

    // ============================================
    // MAIN COMMANDS
    // ============================================

    // Command: Save Profile
    const saveCmd = vscode.commands.registerCommand('antigravity-switcher.saveProfile', async () => {
        const profileName = await vscode.window.showInputBox({
            prompt: 'Enter a name for this profile',
            placeHolder: 'Profile name',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) return 'Profile name cannot be empty';
                return null;
            }
        });

        if (!profileName) return;

        const email = await vscode.window.showInputBox({
            prompt: 'Enter email address for this account (optional)',
            placeHolder: 'Email address'
        });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Saving profile "${profileName}"...`,
            cancellable: false
        }, async () => {
            const result = await runProfileManager('Save', profileName, '', email);
            if (result.success) {
                setActiveProfile(profileName);
                await quotaManager.fetchQuota();
                clearProfilesCache();
                updateProfileButtons();
            } else {
                vscode.window.showErrorMessage(`Failed to save: ${result.error}`);
            }
        });
    });
    context.subscriptions.push(saveCmd);

    // Command: Delete Profile
    const deleteCmd = vscode.commands.registerCommand('antigravity-switcher.deleteProfile', async () => {
        const profiles = await getProfiles();
        if (profiles.length === 0) return;

        const items = profiles.map(p => ({ label: p.Name || p.name }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a profile to delete' });

        if (!selected) return;

        const confirm = await vscode.window.showWarningMessage(`Delete "${selected.label}"?`, { modal: true }, 'Delete');
        if (confirm !== 'Delete') return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Deleting profile "${selected.label}"...`,
            cancellable: false
        }, async () => {
            const result = await runProfileManager('Delete', selected.label);
            if (result.success) {
                clearProfilesCache();
                updateProfileButtons();
            }
        });
    });
    context.subscriptions.push(deleteCmd);

    // Command: Switch Profile (via Command Palette or ">" button)
    const switchCmd = vscode.commands.registerCommand('antigravity-switcher.switchProfile', async () => {
        const profiles = await getProfiles();
        const activeName = getActiveProfile();
        
        // Sort: Active first, then by availability score
        profiles.sort((a, b) => {
            const nameA = a.Name || a.name;
            const nameB = b.Name || b.name;
            const isActiveA = activeName && activeName.toLowerCase() === nameA.toLowerCase();
            const isActiveB = activeName && activeName.toLowerCase() === nameB.toLowerCase();
            
            if (isActiveA) return -1;
            if (isActiveB) return 1;
            
            return quotaManager.getAvailabilityScore(nameB) - quotaManager.getAvailabilityScore(nameA);
        });

        const items = profiles.map(p => ({
            label: `${activeName && activeName.toLowerCase() === (p.Name || p.name).toLowerCase() ? '$(check)' : '$(account)'} ${quotaManager.getAvailabilityPrefix(p.Name || p.name)}${p.Name || p.name}`,
            profileName: p.Name || p.name
        }));

        const selected = await vscode.window.showQuickPick(items, { 
            placeHolder: 'Select a profile to switch to' 
        });
        
        if (!selected) return;

        if (activeName && activeName.toLowerCase() === selected.profileName.toLowerCase()) {
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Switching to "${selected.profileName}"...`,
            cancellable: false
        }, async () => {
            saveFullWorkspaceState();
            setActiveProfile(selected.profileName);
            await runProfileManager('Load', selected.profileName);
        });
    });
    context.subscriptions.push(switchCmd);

    // Command: Set Active Profile (without switching)
    const setActiveCmd = vscode.commands.registerCommand('antigravity-switcher.setActiveProfile', async () => {
        const profiles = await getProfiles();
        if (profiles.length === 0) return;

        const items = profiles.map(p => ({
            label: `$(account) ${p.Name || p.name}`,
            profileName: p.Name || p.name
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select which profile is currently active (no restart)'
        });

        if (!selected) return;

        setActiveProfile(selected.profileName);
        updateProfileButtons();
        vscode.window.showInformationMessage(`"${selected.profileName}" is now marked as the active profile.`);
    });
    context.subscriptions.push(setActiveCmd);

    // Initial update and periodic quota fetch
    updateProfileButtons();
    
    // Initial fetch after a short delay to allow language server to start
    setTimeout(() => quotaManager.fetchQuota().then(() => updateProfileButtons()), 5000);
    
    // Refresh quota every 2 minutes
    const quotaRefreshInterval = setInterval(async () => {
        await quotaManager.fetchQuota();
        updateProfileButtons();
    }, 120000);

    // Command: More Menu (Request 5 & 6)
    const moreMenuCmd = vscode.commands.registerCommand('antigravity-switcher.moreMenu', async () => {
        const items = [
            { label: '$(account) Switch Profile', id: 'switch', description: 'Quickly switch between saved accounts' },
            { label: '$(settings-gear) Manage Users', id: 'manage', description: 'Save, delete or rename profiles' },
            { label: '$(sync) Refresh Quota', id: 'refresh', description: 'Force update all telemetry data' },
            { label: '$(dashboard) Open Dashboard', id: 'dashboard', description: 'Detailed model availability view' }
        ];
        
        const selected = await vscode.window.showQuickPick(items, { 
            placeHolder: 'Antigravity Account Switcher Menu',
            title: 'Menu'
        });
        
        if (!selected) return;
        
        switch (selected.id) {
            case 'switch':
                vscode.commands.executeCommand('antigravity-switcher.switchProfile');
                break;
            case 'manage':
                vscode.commands.executeCommand('antigravity-switcher.manageUsers');
                break;
            case 'refresh':
                vscode.commands.executeCommand('antigravity-switcher.refreshQuota');
                break;
            case 'dashboard':
                vscode.commands.executeCommand('antigravity-switcher.pinQuota');
                break;
        }
    });
    context.subscriptions.push(moreMenuCmd);

    // Command: Manage Users (Request 5)
    const manageUsersCmd = vscode.commands.registerCommand('antigravity-switcher.manageUsers', async () => {
        const profiles = await getProfiles();
        const activeName = getActiveProfile();
        
        const items = [
            { label: '$(add) Save Current Session as New Profile', id: 'save' },
            { label: '$(trash) Delete a Profile', id: 'delete' },
            { label: '$(account) Set Active Profile (Manual)', id: 'setActive' }
        ];
        
        if (profiles.length > 0) {
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            profiles.forEach(p => {
                const name = p.Name || p.name;
                const isActive = activeName && activeName.toLowerCase() === name.toLowerCase();
                items.push({ 
                    label: `${isActive ? '$(check)' : '$(account)'} ${name}`, 
                    description: isActive ? 'Currently Active' : '',
                    id: 'profile',
                    profileName: name
                });
            });
        }
        
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'User Management' });
        if (!selected) return;
        
        if (selected.id === 'save') {
            vscode.commands.executeCommand('antigravity-switcher.saveProfile');
        } else if (selected.id === 'delete') {
            vscode.commands.executeCommand('antigravity-switcher.deleteProfile');
        } else if (selected.id === 'setActive') {
            vscode.commands.executeCommand('antigravity-switcher.setActiveProfile');
        } else if (selected.id === 'profile') {
            // Options for specific profile
            const profileActions = [
                { label: '$(rocket) Switch to this Account', id: 'switch' },
                { label: '$(edit) Rename this Profile', id: 'rename' },
                { label: '$(trash) Delete this Profile', id: 'delete' }
            ];
            const action = await vscode.window.showQuickPick(profileActions, { title: selected.profileName });
            if (!action) return;
            
            if (action.id === 'switch') {
                vscode.commands.executeCommand('antigravity-switcher.switchAccountExplicit', selected.profileName);
            } else if (action.id === 'rename') {
                vscode.commands.executeCommand('antigravity-switcher.renameProfile', selected.profileName);
            } else if (action.id === 'delete') {
                const confirm = await vscode.window.showWarningMessage(`Delete "${selected.profileName}"?`, { modal: true }, 'Delete');
                if (confirm === 'Delete') {
                    await runProfileManager('Delete', selected.profileName);
                    clearProfilesCache();
                    updateProfileButtons();
                }
            }
        }
    });
    context.subscriptions.push(manageUsersCmd);

    // Command: Rename Profile (New)
    const renameCmd = vscode.commands.registerCommand('antigravity-switcher.renameProfile', async (oldName) => {
        if (!oldName) {
            const profiles = await getProfiles();
            const items = profiles.map(p => ({ label: p.Name || p.name }));
            const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select profile to rename' });
            if (!selected) return;
            oldName = selected.label;
        }

        const newName = await vscode.window.showInputBox({
            prompt: `Enter new name for profile "${oldName}"`,
            value: oldName,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) return 'Name cannot be empty';
                if (value === oldName) return 'Name is the same';
                return null;
            }
        });

        if (!newName) return;

        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Renaming "${oldName}" to "${newName}"...`,
            cancellable: false
        }, async () => {
            const result = await runProfileManager('Rename', oldName, newName);
            if (result.success) {
                // Update active profile tracker if we renamed the active one
                const currentActive = getActiveProfile();
                if (currentActive && currentActive.toLowerCase() === oldName.toLowerCase()) {
                    setActiveProfile(newName);
                }
                // Update quota cache
                if (quotaManager.cache[oldName]) {
                    quotaManager.cache[newName] = quotaManager.cache[oldName];
                    delete quotaManager.cache[oldName];
                    quotaManager.saveCache();
                }
                clearProfilesCache();
                updateProfileButtons();
                vscode.window.showInformationMessage(`Profile renamed to "${newName}"`);
                return { success: true, newName: newName };
            } else {
                vscode.window.showErrorMessage(`Failed to rename: ${result.error}`);
                return { success: false };
            }
        });
    });
    context.subscriptions.push(renameCmd);

    // Command: List Profiles (Resolves the error shown in screenshot)
    const listProfilesCmd = vscode.commands.registerCommand('antigravity-switcher.listProfiles', () => {
        vscode.commands.executeCommand('antigravity-switcher.manageUsers');
    });
    context.subscriptions.push(listProfilesCmd);

    // Command: Set Email (New)
    const setEmailCmd = vscode.commands.registerCommand('antigravity-switcher.setEmail', async (profileName) => {
        if (!profileName) return;
        
        const email = await vscode.window.showInputBox({
            prompt: `Set email for profile "${profileName}"`,
            placeHolder: 'e.g. user@gmail.com'
        });
        
        if (email === undefined) return;
        
        const result = await runProfileManager('SetEmail', profileName, '', email);
        if (result.success) {
            clearProfilesCache();
            updateProfileButtons();
            vscode.window.showInformationMessage(`Email updated for profile "${profileName}"`);
        }
    });
    context.subscriptions.push(setEmailCmd);

    // Register explicit switch command (for webview and tooltip)
    const switchExplicitCmd = vscode.commands.registerCommand('antigravity-switcher.switchAccountExplicit', async (profileName) => {
        const activeName = getActiveProfile();
        if (activeName && activeName.toLowerCase() === profileName.toLowerCase()) {
            quotaDashboard.show(quotaManager);
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Switching to "${profileName}"...`,
            cancellable: false
        }, async () => {
            saveFullWorkspaceState();
            setActiveProfile(profileName);
            await runProfileManager('Load', profileName);
        });
    });
    context.subscriptions.push(switchExplicitCmd);
}

function deactivate() {
    console.log('Antigravity Account Switcher deactivated');
}

module.exports = {
    activate,
    deactivate
};
