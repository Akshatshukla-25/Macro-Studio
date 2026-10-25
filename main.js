/**
 * @fileoverview Macro Studio Main Electron Process.
 * Manages the application lifecycle, secure browser window initialization,
 * system tray presence, global shortcut registration, scheduled execution daemon,
 * and IPC message routing.
 *
 * @author Akshat Shukla
 * @license MIT
 */

'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  Notification
} = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const store = require('./src/storage');
const { validateAction } = require('./src/schema');
const { runMacro, isDangerous } = require('./src/macroEngine');

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {Tray|null} */
let tray = null;

/** @type {AbortController|null} */
let activeExecutionController = null;

/** @type {((choice: 'retry'|'skip'|'stop') => void)|null} */
let pendingFailureResolver = null;

/** @type {NodeJS.Timeout|null} */
let scheduleInterval = null;

/**
 * Creates and configures the main desktop window.
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: 'Macro Studio',
    backgroundColor: '#07080b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  // Minimize to tray behavior on close if user prefers
  mainWindow.on('close', (event) => {
    if (!app.isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

/**
 * Verifies that an IPC event originated from our trusted mainWindow webContents.
 * @param {Electron.IpcMainInvokeEvent|Electron.IpcMainEvent} event
 * @returns {boolean}
 */
function isFromTrustedWindow(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

/**
 * Safely dispatches an event to the renderer process.
 * @param {string} channel
 * @param {unknown} payload
 */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/**
 * Formats caught errors into standardized response objects.
 * @param {Error|unknown} err
 * @returns {{ ok: false, error: string }}
 */
function formatError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: message };
}

/**
 * Core executor for running a macro by identifier.
 * Shared between IPC, global shortcuts, system tray, and scheduled daemon.
 *
 * @param {string} macroId
 * @returns {Promise<{ ok: boolean, error?: string, cancelled?: boolean }>}
 */
async function executeMacroById(macroId) {
  if (activeExecutionController) {
    return { ok: false, error: 'Another macro is currently executing.' };
  }

  const allMacros = await store.list();
  const macro = allMacros.find((m) => m.id === macroId);
  if (!macro) {
    return { ok: false, error: 'Macro not found. Please save before executing.' };
  }

  // Pre-flight validation
  for (let i = 0; i < macro.actions.length; i++) {
    try {
      validateAction(macro.actions[i]);
    } catch (err) {
      return { ok: false, error: `Step ${i + 1}: ${err.message}` };
    }
  }

  // Command security confirmation
  const commandActions = macro.actions.filter((a) => a.type === 'command');
  if (commandActions.length > 0) {
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(commandActions.map((c) => [c.value, c.cwd || ''])))
      .digest('hex');

    const approvals = await store.getApprovals();
    if (approvals[macro.id] !== fingerprint) {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }

      const containsRisky = commandActions.some((c) => isDangerous(c.value));
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: containsRisky ? 'warning' : 'question',
        buttons: ['Cancel', 'Trust and Execute'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Confirm Terminal Commands',
        message: containsRisky
          ? 'Security Alert: This workflow includes commands with high-risk patterns.'
          : `Confirm execution of terminal commands in "${macro.name}".`,
        detail:
          commandActions
            .map((c, idx) => `${idx + 1}. ${isDangerous(c.value) ? '[POTENTIALLY RISKY] ' : ''}${c.value}`)
            .join('\n') + '\n\nOnly proceed if you created or completely trust these commands.'
      });

      if (response !== 1) {
        return { ok: false, cancelled: true };
      }

      await store.setApproval(macro.id, fingerprint);
    }
  }

  activeExecutionController = new AbortController();
  sendToRenderer('macro:started', { macroId });

  runMacro(macro, {
    signal: activeExecutionController.signal,
    onStatus: (stepIndex, status, message) => {
      sendToRenderer('macro:status', { stepIndex, status, message });
    },
    decide: (stepIndex, error) => {
      return new Promise((resolve) => {
        pendingFailureResolver = resolve;
      });
    }
  })
    .then((result) => {
      sendToRenderer('macro:done', { result });
      if (Notification.isSupported() && (!mainWindow || !mainWindow.isFocused())) {
        new Notification({
          title: 'Macro Studio',
          body: `"${macro.name}" completed successfully.`
        }).show();
      }
    })
    .catch((err) => {
      sendToRenderer('macro:done', { result: 'stopped', error: err.message });
    })
    .finally(() => {
      activeExecutionController = null;
      pendingFailureResolver = null;
    });

  return { ok: true };
}

/**
 * Refreshes system tray icon and context menu.
 */
async function updateTrayMenu() {
  if (!tray) return;

  const macros = await store.list();
  const macroMenuItems = macros.map((m) => ({
    label: `▶ ${m.name}`,
    click: () => executeMacroById(m.id)
  }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Macro Studio',
      enabled: false
    },
    { type: 'separator' },
    ...macroMenuItems,
    ...(macroMenuItems.length > 0 ? [{ type: 'separator' }] : []),
    {
      label: 'Open Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * Initializes the system tray.
 */
function setupTray() {
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const icon = nativeImage
    .createFromDataURL(`data:image/svg+xml;utf8,${encodeURIComponent(iconSvg)}`)
    .resize({ width: 18, height: 18 });

  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setToolTip('Macro Studio — Visual Automation Builder');
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  updateTrayMenu();
}

/**
 * Synchronizes global hotkey shortcuts for macros with configured key bindings.
 */
async function syncGlobalShortcuts() {
  globalShortcut.unregisterAll();
  const macros = await store.list();

  for (const m of macros) {
    if (m.hotkey && typeof m.hotkey === 'string' && m.hotkey.trim()) {
      try {
        const registered = globalShortcut.register(m.hotkey.trim(), () => {
          executeMacroById(m.id);
        });
        if (!registered) {
          console.warn(`[Hotkeys] Failed to bind hotkey "${m.hotkey}" for macro "${m.name}".`);
        }
      } catch (err) {
        console.error(`[Hotkeys] Error registering hotkey:`, err);
      }
    }
  }
}

/**
 * Starts the background daemon to check scheduled macro triggers every minute.
 */
function startScheduleDaemon() {
  let lastTriggeredMinute = '';

  scheduleInterval = setInterval(async () => {
    const now = new Date();
    const currentMinute = now.toTimeString().slice(0, 5); // "HH:MM"

    if (currentMinute === lastTriggeredMinute) return;
    lastTriggeredMinute = currentMinute;

    try {
      const macros = await store.list();
      for (const m of macros) {
        if (m.schedule === currentMinute) {
          console.log(`[Schedule] Triggering scheduled macro "${m.name}" at ${currentMinute}`);
          executeMacroById(m.id);
        }
      }
    } catch (err) {
      console.error('[Schedule] Error executing scheduled checks:', err);
    }
  }, 30000); // Check every 30 seconds
}

/**
 * Registers secure IPC handlers.
 */
function registerIpcHandlers() {
  ipcMain.handle('macros:list', async (event) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const macros = await store.list();
      return { ok: true, macros };
    } catch (err) {
      return formatError(err);
    }
  });

  ipcMain.handle('macros:templates', async (event) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const templatesPath = path.join(__dirname, 'data', 'templates.json');
      const templates = await store.readJson(templatesPath, []);
      return { ok: true, templates };
    } catch (err) {
      return formatError(err);
    }
  });

  ipcMain.handle('macros:save', async (event, macroData) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const saved = await store.save(macroData);
      updateTrayMenu();
      syncGlobalShortcuts();
      return { ok: true, macro: saved };
    } catch (err) {
      return formatError(err);
    }
  });

  ipcMain.handle('macros:delete', async (event, macroId) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      await store.remove(String(macroId));
      updateTrayMenu();
      syncGlobalShortcuts();
      return { ok: true };
    } catch (err) {
      return formatError(err);
    }
  });

  ipcMain.handle('macro:run', async (event, macroId) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    return executeMacroById(macroId);
  });

  // Export Macro to File
  ipcMain.handle('macros:export', async (event, macroId) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const jsonStr = await store.exportJson(macroId);
      const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Workflow JSON',
        defaultPath: macroId ? `macro-${macroId}.json` : 'all-macros.json',
        filters: [{ name: 'JSON Workflows', extensions: ['json'] }]
      });

      if (canceled || !filePath) return { ok: false, canceled: true };
      await fs.writeFile(filePath, jsonStr, 'utf8');
      return { ok: true, filePath };
    } catch (err) {
      return formatError(err);
    }
  });

  // Import Macro from File
  ipcMain.handle('macros:import', async (event) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Workflow JSON',
        filters: [{ name: 'JSON Workflows', extensions: ['json'] }],
        properties: ['openFile']
      });

      if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
      const raw = await fs.readFile(filePaths[0], 'utf8');
      const imported = await store.importJson(raw);
      updateTrayMenu();
      syncGlobalShortcuts();
      return { ok: true, imported };
    } catch (err) {
      return formatError(err);
    }
  });

  // Direct clipboard JSON import
  ipcMain.handle('macros:importJson', async (event, jsonString) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const imported = await store.importJson(jsonString);
      updateTrayMenu();
      syncGlobalShortcuts();
      return { ok: true, imported };
    } catch (err) {
      return formatError(err);
    }
  });

  ipcMain.on('macro:decision', (event, choice) => {
    if (!isFromTrustedWindow(event) || !pendingFailureResolver) return;
    const resolver = pendingFailureResolver;
    pendingFailureResolver = null;
    const safeChoice = ['retry', 'skip', 'stop'].includes(choice) ? choice : 'stop';
    resolver(safeChoice);
  });

  ipcMain.on('macro:stop', (event) => {
    if (!isFromTrustedWindow(event) || !activeExecutionController) return;
    activeExecutionController.abort();
    if (pendingFailureResolver) {
      const resolver = pendingFailureResolver;
      pendingFailureResolver = null;
      resolver('stop');
    }
  });
}

// App lifecycle initialization
app.whenReady().then(async () => {
  app.setAppUserModelId('com.macrostudio.app');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
        ]
      }
    });
  });

  await store.init(path.join(app.getPath('userData'), 'macro-studio'));
  registerIpcHandlers();
  createMainWindow();
  setupTray();
  syncGlobalShortcuts();
  startScheduleDaemon();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (scheduleInterval) clearInterval(scheduleInterval);
});

app.on('window-all-closed', () => {
  // If tray is active, keep running in background like Spotify/Slack
  if (process.platform !== 'darwin' && !tray) {
    app.quit();
  }
});
