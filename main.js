/**
 * @fileoverview Macro Studio Main Electron Process.
 * Manages the application lifecycle, secure browser window initialization,
 * Content Security Policy enforcement, and IPC message routing.
 *
 * @author Akshat Shukla
 * @license MIT
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const crypto = require('crypto');
const store = require('./src/storage');
const { validateAction } = require('./src/schema');
const { runMacro, isDangerous } = require('./src/macroEngine');

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {AbortController|null} */
let activeExecutionController = null;

/** @type {((choice: 'retry'|'skip'|'stop') => void)|null} */
let pendingFailureResolver = null;

/**
 * Creates and configures the main desktop window.
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 840,
    minHeight: 540,
    title: 'Macro Studio',
    backgroundColor: '#050507',
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

  // Security: deny new window creation and external navigation
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
 * Registers secure IPC handlers between renderer and main process.
 */
function registerIpcHandlers() {
  // Query all stored macros
  ipcMain.handle('macros:list', async (event) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const macros = await store.list();
      return { ok: true, macros };
    } catch (err) {
      return formatError(err);
    }
  });

  // Query workflow templates
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

  // Save or update a macro
  ipcMain.handle('macros:save', async (event, macroData) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      const saved = await store.save(macroData);
      return { ok: true, macro: saved };
    } catch (err) {
      return formatError(err);
    }
  });

  // Delete a macro
  ipcMain.handle('macros:delete', async (event, macroId) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    try {
      await store.remove(String(macroId));
      return { ok: true };
    } catch (err) {
      return formatError(err);
    }
  });

  // Execute a macro workflow
  ipcMain.handle('macro:run', async (event, macroId) => {
    if (!isFromTrustedWindow(event)) return { ok: false, error: 'Unauthorized sender.' };
    if (activeExecutionController) {
      return { ok: false, error: 'Another macro is currently executing.' };
    }

    const allMacros = await store.list();
    const macro = allMacros.find((m) => m.id === macroId);
    if (!macro) {
      return { ok: false, error: 'Macro not found. Please save before executing.' };
    }

    // Step 1: Pre-flight validation of all action steps
    for (let i = 0; i < macro.actions.length; i++) {
      try {
        validateAction(macro.actions[i]);
      } catch (validationErr) {
        return { ok: false, error: `Step ${i + 1}: ${validationErr.message}` };
      }
    }

    // Step 2: Security approval for shell commands
    const commandActions = macro.actions.filter((a) => a.type === 'command');
    if (commandActions.length > 0) {
      const commandFingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify(commandActions.map((c) => [c.value, c.cwd || ''])))
        .digest('hex');

      const approvals = await store.getApprovals();
      if (approvals[macro.id] !== commandFingerprint) {
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

        await store.setApproval(macro.id, commandFingerprint);
      }
    }

    // Step 3: Launch sequential execution
    activeExecutionController = new AbortController();

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
      })
      .catch((err) => {
        sendToRenderer('macro:done', { result: 'stopped', error: err.message });
      })
      .finally(() => {
        activeExecutionController = null;
        pendingFailureResolver = null;
      });

    return { ok: true };
  });

  // Handle user decision on failed steps (retry / skip / stop)
  ipcMain.on('macro:decision', (event, choice) => {
    if (!isFromTrustedWindow(event) || !pendingFailureResolver) return;
    const resolver = pendingFailureResolver;
    pendingFailureResolver = null;
    const safeChoice = ['retry', 'skip', 'stop'].includes(choice) ? choice : 'stop';
    resolver(safeChoice);
  });

  // Stop running macro
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

// App lifecycle
app.whenReady().then(async () => {
  app.setAppUserModelId('com.macrostudio.app');

  // Strict Content-Security-Policy injection
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
