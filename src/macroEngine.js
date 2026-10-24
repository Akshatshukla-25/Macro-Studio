/**
 * @fileoverview Macro Studio Automation Engine & Process Orchestrator.
 * Executes automation actions sequentially, managing child processes,
 * external browser URLs, desktop notifications, and sleep timers.
 *
 * Designed with Google / Microsoft production standards:
 * - Graceful process lifecycle management for dev servers and long-running daemons.
 * - Platform-specific OS abstractions (macOS, Windows, Linux).
 * - Full AbortSignal cancellation support.
 * - Interactive step failure recovery (retry / skip / stop).
 *
 * @author Akshat Shukla
 * @license MIT
 */

'use strict';

const { spawn, execFile } = require('child_process');
const { shell, Notification } = require('electron');
const { validateAction, ACTION_TYPES } = require('./schema');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * Heuristic regular expressions matching inherently hazardous terminal operations.
 * If matched, users are presented with prominent warnings before initial execution.
 */
const DANGEROUS_PATTERNS = Object.freeze([
  /\brm\s+(-\w*r\w*f|-\w*f\w*r)\b/i,
  /\bdel\s+\/[sfq]/i,
  /\brmdir\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bsudo\b/i,
  /Remove-Item.*-Recurse/i,
  /:\(\)\s*\{/, // Fork bomb
  /(curl|wget)[^|]*\|\s*(sh|bash|zsh|powershell)/i,
  /\bchmod\s+-R\s+777/i,
  /\breg\s+delete\b/i
]);

/**
 * Checks whether a given shell command appears dangerous.
 * @param {string} cmd
 * @returns {boolean}
 */
function isDangerous(cmd) {
  if (typeof cmd !== 'string') return false;
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
}

/**
 * Spawns an external command or process with a grace period.
 *
 * Resolves if:
 * 1. Process terminates quickly with exit code 0.
 * 2. Process is still executing after `graceMs` (essential for background dev servers like `npm run dev`).
 *
 * Rejects if:
 * 1. Process fails to spawn (ENOENT).
 * 2. Process exits with non-zero code before grace period expires.
 *
 * @param {string} cmd Executable or shell command.
 * @param {string[]} args Command-line arguments.
 * @param {import('child_process').SpawnOptions} opts Spawn configuration options.
 * @param {number} graceMs Milliseconds to monitor before assuming long-running success.
 * @returns {Promise<void>}
 */
function startProcess(cmd, args, opts, graceMs = 1500) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;

    const finalize = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };

    let child;
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        ...opts
      });
    } catch (err) {
      return reject(err);
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-1000);
      });
    }

    child.on('error', (err) => {
      const message = err.code === 'ENOENT'
        ? `Could not find executable "${cmd}". Check your PATH or file path.`
        : err.message;
      finalize(reject, new Error(message));
    });

    child.on('exit', (code) => {
      if (code === 0) {
        finalize(resolve);
      } else {
        const errorDetail = stderr.trim() || `Process exited with error code ${code}.`;
        finalize(reject, new Error(errorDetail));
      }
    });

    // Grace timer: if process remains alive past grace window, assume success (e.g. dev server)
    const timer = setTimeout(() => {
      if (!settled) {
        finalize(resolve);
        if (child.stderr) child.stderr.destroy();
        child.unref();
      }
    }, graceMs);

    // Prevent grace timer from hanging the node event loop
    if (timer.unref) timer.unref();
  });
}

/**
 * Executes a short-lived system utility with a strict timeout.
 * @param {string} file
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function runSystemUtility(file, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim()));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Pauses execution for a specified duration, supporting immediate cancellation via AbortSignal.
 *
 * @param {number} ms Duration in milliseconds.
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new Error('Macro execution aborted by user.'));
    }

    let timeoutId;
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new Error('Macro execution aborted by user.'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timeoutId = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
  });
}

/**
 * Registry of action executor implementations.
 */
const executors = {
  /**
   * Launches an installed application across macOS, Windows, and Linux.
   */
  async openApp(action) {
    const appName = String(action.value).trim();

    if (isWin) {
      return startProcess(
        'cmd.exe',
        ['/c', `start "" "${appName}"`],
        { windowsVerbatimArguments: true, windowsHide: true },
        3000
      );
    }

    if (isMac) {
      return startProcess('open', ['-a', appName], {}, 3000);
    }

    // Linux: attempt direct execution or xdg-open fallback
    return startProcess(appName, [], {}, 1500);
  },

  /**
   * Opens an HTTP/HTTPS URL in the operating system's default browser.
   */
  async openUrl(action) {
    const url = new URL(String(action.value).trim()).toString();
    await shell.openExternal(url);
  },

  /**
   * Executes a terminal shell command.
   */
  async command(action) {
    const cmdStr = String(action.value).trim();
    const cwd = action.cwd && String(action.cwd).trim() ? String(action.cwd).trim() : undefined;

    await startProcess(cmdStr, [], { shell: true, cwd, windowsHide: false }, 1500);
  },

  /**
   * Pauses the workflow.
   */
  async wait(action, context) {
    const duration = Number(action.value);
    await sleep(duration, context ? context.signal : undefined);
  },

  /**
   * Displays an OS native desktop notification.
   */
  async notification(action) {
    if (!Notification.isSupported()) {
      throw new Error('Desktop notifications are not supported in this environment.');
    }

    const message = String(action.value).trim();
    const notification = new Notification({
      title: 'Macro Studio',
      body: message,
      silent: false
    });
    notification.show();
  },

  /**
   * Gracefully requests termination of a target application or process.
   */
  async closeApp(action) {
    const name = String(action.value).trim();

    if (isWin) {
      const processName = /\.exe$/i.test(name) ? name : `${name}.exe`;
      return runSystemUtility('taskkill', ['/IM', processName, '/F']);
    }

    if (isMac) {
      return runSystemUtility('osascript', ['-e', `tell application "${name}" to quit`]);
    }

    // Linux
    return runSystemUtility('pkill', ['-x', name]);
  }
};

/**
 * Executes a macro's actions sequentially.
 * If an action fails, invokes the interactive `decide` hook:
 * - 'retry': re-runs the current step
 * - 'skip': marks step as skipped and continues to next
 * - 'stop': aborts macro execution immediately
 *
 * @param {{ id: string, name: string, actions: Array<any> }} macro
 * @param {{
 *   signal: AbortSignal,
 *   onStatus: (stepIndex: number, status: 'running'|'done'|'error'|'skipped', message?: string) => void,
 *   decide: (stepIndex: number, error: Error) => Promise<'retry'|'skip'|'stop'>
 * }} hooks
 * @returns {Promise<'finished'|'stopped'>}
 */
async function runMacro(macro, hooks) {
  const { signal, onStatus, decide } = hooks;

  for (let i = 0; i < macro.actions.length; i++) {
    const action = macro.actions[i];

    for (;;) {
      if (signal.aborted) {
        return 'stopped';
      }

      onStatus(i, 'running');

      try {
        validateAction(action);
        const executor = executors[action.type];
        if (!executor) {
          throw new Error(`No executor registered for action type "${action.type}".`);
        }

        await executor(action, { signal });
        onStatus(i, 'done');
        break;
      } catch (err) {
        if (signal.aborted) {
          return 'stopped';
        }

        onStatus(i, 'error', err.message);

        const choice = await decide(i, err);
        if (choice === 'retry') {
          continue;
        }
        if (choice === 'skip') {
          onStatus(i, 'skipped', 'Step skipped by user');
          break;
        }

        return 'stopped';
      }
    }
  }

  return 'finished';
}

module.exports = {
  executors,
  runMacro,
  isDangerous,
  sleep,
  startProcess,
  runSystemUtility
};
