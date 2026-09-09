import { app, BrowserWindow, globalShortcut, ipcMain, shell, desktopCapturer } from 'electron';
import path from 'path';

let win: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

// ── Custom Protocol & OAuth Deep Link Handling ────────────────────────────────
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('axiom-overlay', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('axiom-overlay');
}

let pendingDeepLinkUrl: string | null = null;

function handleDeepLink(url: string) {
    if (!url) return;
    try {
        const hashIndex = url.indexOf('#');
        const queryIndex = url.indexOf('?');
        let paramString = '';

        if (hashIndex !== -1) {
            paramString = url.substring(hashIndex + 1);
        } else if (queryIndex !== -1) {
            paramString = url.substring(queryIndex + 1);
        }

        const params = new URLSearchParams(paramString);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        if (accessToken && refreshToken) {
            if (win && win.webContents) {
                win.webContents.send('oauth-callback', { access_token: accessToken, refresh_token: refreshToken });
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
            } else {
                pendingDeepLinkUrl = url;
            }
        }
    } catch (err) {
        console.error('[Main] Deep link handling error:', err);
    }
}

// Single instance lock for Windows
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine) => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
        const url = commandLine.find(arg => arg.startsWith('axiom-overlay://'));
        if (url) handleDeepLink(url);
    });
}

// Deep link handler for macOS
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

function createWindow() {
    const isWindows = process.platform === 'win32';
    win = new BrowserWindow({
        width: 420,
        height: 640,
        frame: false,
        transparent: !isWindows,
        backgroundColor: isWindows ? '#0c0c0e' : '#00000000',
        hasShadow: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // ── Hidden from screen capture (Windows & macOS) ────────────────────────────
    // On Windows, transparent windows (WS_EX_LAYERED) cause DWM to fail exclusion
    // and fall back to WDA_MONITOR (solid black rectangle). Using a non-layered window
    // with opacity 1.0 allows DWM to cleanly apply WDA_EXCLUDEFROMCAPTURE (0x11).
    win.setOpacity(1.0);
    win.setContentProtection(true);

    // Visible on all workspaces including fullscreen apps
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Float above all other windows
    win.setAlwaysOnTop(true, 'floating');

    // Hide from Mission Control / Cmd+Tab switcher
    if (process.platform === 'darwin') {
        win.setHiddenInMissionControl(true);
    }

    // Position: bottom-right corner
    const { screen } = require('electron');
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    win.setPosition(width - 440, height - 660);

    // Load app
    if (isDev) {
        const loadDevServer = () => {
            win?.loadURL('http://localhost:5173').catch(() => {
                setTimeout(loadDevServer, 500);
            });
        };
        loadDevServer();
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    win.webContents.on('did-finish-load', () => {
        if (pendingDeepLinkUrl) {
            handleDeepLink(pendingDeepLinkUrl);
            pendingDeepLinkUrl = null;
        }
    });
}

app.whenReady().then(() => {
    createWindow();

    // ── Global shortcuts ─────────────────────────────────────────────────────────
    // Toggle visibility
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
        if (!win) return;
        if (win.isVisible()) {
            win.hide();
        } else {
            win.show();
            win.focus();
        }
    });

    // Move window: Cmd+Arrow keys
    (['Up', 'Down', 'Left', 'Right'] as const).forEach(dir => {
        globalShortcut.register(`CommandOrControl+${dir}`, () => {
            if (!win) return;
            const [x, y] = win.getPosition();
            const step = 20;
            const moves: Record<string, [number, number]> = {
                Up: [x, y - step], Down: [x, y + step],
                Left: [x - step, y], Right: [x + step, y],
            };
            win.setPosition(...moves[dir]);
        });
    });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url));

ipcMain.handle('set-always-on-top', (_e, value: boolean) => {
    win?.setAlwaysOnTop(value, 'floating');
});

ipcMain.on('minimize-window', () => {
    if (win) win.minimize();
});

ipcMain.on('close-window', () => {
    if (win) win.hide();
});

ipcMain.handle('get-desktop-sources', async () => {
    return await desktopCapturer.getSources({ types: ['screen', 'window'] });
});

// ── Auto Updater Setup ────────────────────────────────────────────────────────
import { autoUpdater } from 'electron-updater';

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
    win?.webContents.send('update-status', { status: 'available', version: info.version });
});

autoUpdater.on('update-downloaded', (info) => {
    win?.webContents.send('update-status', { status: 'downloaded', version: info.version });
});

autoUpdater.on('error', (err) => {
    win?.webContents.send('update-status', { status: 'error', message: err?.message || 'Update error' });
});

ipcMain.handle('check-for-updates', async () => {
    try {
        const currentVersion = app.getVersion();
        const res = await fetch('https://axiomtranscriber.vercel.app/api/releases/latest');
        if (res.ok) {
            const release: any = await res.json();
            const minRequired = release.min_required_version;
            const isCritical = release.critical;

            if ((isCritical || minRequired) && isVersionLower(currentVersion, minRequired || release.version)) {
                win?.webContents.send('update-status', {
                    status: 'critical_required',
                    version: release.version,
                    minRequired: minRequired || release.version,
                    notes: release.releaseNotes,
                });
            }
        }

        if (!isDev) {
            autoUpdater.checkForUpdates();
        }
    } catch (e: any) {
        console.error('[Main] Update check error:', e);
    }
});

ipcMain.handle('quit-and-install', () => {
    autoUpdater.quitAndInstall();
});

function isVersionLower(current: string, required: string): boolean {
    const p1 = current.split('.').map(Number);
    const p2 = required.split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        const v1 = p1[i] || 0;
        const v2 = p2[i] || 0;
        if (v1 < v2) return true;
        if (v1 > v2) return false;
    }
    return false;
}
