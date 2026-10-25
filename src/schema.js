/**
 * @fileoverview Macro Studio Data Contract, Validation & Interpolation Engine.
 * Provides runtime sanitization, parameter boundary validation, dynamic variable
 * interpolation, and security defenses against injection for desktop macro actions.
 *
 * @author Akshat Shukla
 * @license MIT
 */

'use strict';

/**
 * Supported automation action types.
 * @readonly
 * @enum {string}
 */
const ACTION_TYPES = Object.freeze({
  OPEN_APP: 'openApp',
  OPEN_URL: 'openUrl',
  COMMAND: 'command',
  WAIT: 'wait',
  NOTIFICATION: 'notification',
  CLOSE_APP: 'closeApp',
  WAIT_FOR_URL: 'waitForUrl',
  SPEAK: 'speak',
  SNAP_WINDOW: 'snapWindow'
});

const TYPES = Object.freeze(Object.values(ACTION_TYPES));

/**
 * Validation boundary constants.
 */
const BOUNDS = Object.freeze({
  MAX_NAME_LENGTH: 80,
  MAX_ACTIONS: 200,
  MAX_VALUE_LENGTH: 2048,
  MAX_CWD_LENGTH: 512,
  MAX_HOTKEY_LENGTH: 64,
  MAX_SCHEDULE_LENGTH: 10,
  MIN_WAIT_MS: 0,
  MAX_WAIT_MS: 3600 * 1000 // 1 hour max wait
});

/**
 * Character sets forbidden in application identifiers to avoid shell injection.
 */
const INJECTION_PATTERNS = Object.freeze({
  APP_NAME: /["&|<>^%`$;\r\n]/,
  CLOSE_APP_NAME: /["&|<>^%`$;\\\r\n]/
});

/**
 * Allowed window snapping positions.
 */
const ALLOWED_SNAP_POSITIONS = Object.freeze(new Set(['left', 'right', 'top', 'bottom', 'maximize']));

/**
 * Valid protocol schemes allowed for URL actions.
 */
const ALLOWED_URL_PROTOCOLS = Object.freeze(new Set(['http:', 'https:']));

/**
 * Verifies if an ID conforms to the alphanumeric/hyphen slug format.
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
}

/**
 * Interpolates variables in a string template.
 * Supported built-in variables:
 * - {{DATE}}: Current date YYYY-MM-DD
 * - {{TIME}}: Current time HH:MM:SS
 * - {{USER}}: Current OS username
 * - {{HOME}}: User home directory
 * - {{env.VAR}}: OS environment variable
 * - {{KEY}}: User-defined macro variables
 *
 * @param {string} template
 * @param {Record<string, string>} [customVars={}]
 * @returns {string}
 */
function interpolateVariables(template, customVars = {}) {
  if (typeof template !== 'string' || !template.includes('{{')) {
    return template;
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const userStr = process.env.USER || process.env.USERNAME || 'user';
  const homeStr = process.env.HOME || process.env.USERPROFILE || '';

  return template.replace(/\{\{([\w.-]+)\}\}/g, (match, token) => {
    if (token === 'DATE') return dateStr;
    if (token === 'TIME') return timeStr;
    if (token === 'USER') return userStr;
    if (token === 'HOME') return homeStr;
    if (token.startsWith('env.')) {
      const envKey = token.slice(4);
      return process.env[envKey] !== undefined ? process.env[envKey] : '';
    }
    if (customVars && Object.prototype.hasOwnProperty.call(customVars, token)) {
      return String(customVars[token]);
    }
    return match; // preserve unrecognised tokens
  });
}

/**
 * Sanitizes a raw macro object for safe persistence.
 * Permissive during draft editing (allows empty values), but strictly bounds lengths
 * and strips unwanted properties.
 *
 * @param {unknown} raw
 * @param {() => string} generateId Fallback identifier generator.
 * @returns {{ id: string, name: string, hotkey?: string, schedule?: string, variables?: Record<string, string>, actions: Array<any> }}
 * @throws {TypeError|RangeError} On fundamentally invalid structural input.
 */
function sanitizeMacro(raw, generateId = () => `macro-${Date.now()}`) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Invalid macro: payload must be a non-null object.');
  }

  const id = isValidId(raw.id) ? raw.id : generateId();
  const name = String(raw.name ?? '').trim().slice(0, BOUNDS.MAX_NAME_LENGTH) || 'Untitled macro';

  const sanitizedMacro = { id, name };

  if (raw.hotkey && typeof raw.hotkey === 'string') {
    sanitizedMacro.hotkey = raw.hotkey.trim().slice(0, BOUNDS.MAX_HOTKEY_LENGTH);
  }

  if (raw.schedule && typeof raw.schedule === 'string') {
    sanitizedMacro.schedule = raw.schedule.trim().slice(0, BOUNDS.MAX_SCHEDULE_LENGTH);
  }

  if (raw.variables && typeof raw.variables === 'object' && !Array.isArray(raw.variables)) {
    const cleanVars = {};
    for (const [k, v] of Object.entries(raw.variables)) {
      if (/^[\w-]+$/.test(k)) {
        cleanVars[k] = String(v ?? '').slice(0, 500);
      }
    }
    sanitizedMacro.variables = cleanVars;
  }

  if (!Array.isArray(raw.actions)) {
    throw new TypeError('Invalid macro: actions must be an array.');
  }

  if (raw.actions.length > BOUNDS.MAX_ACTIONS) {
    throw new RangeError(`A macro cannot exceed ${BOUNDS.MAX_ACTIONS} actions.`);
  }

  sanitizedMacro.actions = raw.actions.map((act, index) => {
    if (!act || typeof act !== 'object') {
      throw new TypeError(`Action at index ${index} must be an object.`);
    }

    if (!TYPES.includes(act.type)) {
      throw new RangeError(`Unsupported action type "${act.type}" at step ${index + 1}.`);
    }

    if (act.type === ACTION_TYPES.WAIT) {
      const waitMs = Math.max(BOUNDS.MIN_WAIT_MS, Number(act.value) || 0);
      return {
        type: ACTION_TYPES.WAIT,
        value: Math.min(waitMs, BOUNDS.MAX_WAIT_MS)
      };
    }

    const sanitized = {
      type: act.type,
      value: String(act.value ?? '').slice(0, BOUNDS.MAX_VALUE_LENGTH)
    };

    if (act.type === ACTION_TYPES.COMMAND && act.cwd) {
      sanitized.cwd = String(act.cwd).slice(0, BOUNDS.MAX_CWD_LENGTH);
    }

    if (act.type === ACTION_TYPES.SNAP_WINDOW && act.position) {
      sanitized.position = ALLOWED_SNAP_POSITIONS.has(act.position) ? act.position : 'maximize';
    }

    if (act.type === ACTION_TYPES.WAIT_FOR_URL && act.timeout) {
      sanitized.timeout = Math.min(60000, Math.max(1000, Number(act.timeout) || 15000));
    }

    return sanitized;
  });

  return sanitizedMacro;
}

/**
 * Validates a single action before execution.
 * Enforces strict values, valid protocols, and injection safety.
 *
 * @param {{ type: string, value: unknown, cwd?: unknown, position?: unknown, timeout?: unknown }} action
 * @throws {Error} Detailed explanation if action fails execution validation.
 */
function validateAction(action) {
  if (!action || typeof action !== 'object') {
    throw new Error('Action must be a valid object.');
  }

  if (!TYPES.includes(action.type)) {
    throw new Error(`Unrecognized action type: "${action.type}".`);
  }

  if (action.type === ACTION_TYPES.WAIT) {
    const duration = Number(action.value);
    if (!Number.isFinite(duration) || duration < BOUNDS.MIN_WAIT_MS || duration > BOUNDS.MAX_WAIT_MS) {
      throw new Error(`Wait duration must be between 0 and ${BOUNDS.MAX_WAIT_MS / 1000} seconds.`);
    }
    return;
  }

  const strValue = String(action.value ?? '').trim();
  if (!strValue) {
    throw new Error('This action step requires a non-empty value.');
  }

  if (action.type === ACTION_TYPES.OPEN_URL || action.type === ACTION_TYPES.WAIT_FOR_URL) {
    let parsedUrl;
    try {
      parsedUrl = new URL(strValue);
    } catch {
      throw new Error(`Invalid URL "${strValue}". Must include protocol (e.g. https://).`);
    }

    if (!ALLOWED_URL_PROTOCOLS.has(parsedUrl.protocol)) {
      throw new Error(`Protocol "${parsedUrl.protocol}" is blocked. Only http and https URLs are allowed.`);
    }
  }

  if (action.type === ACTION_TYPES.OPEN_APP || action.type === ACTION_TYPES.SNAP_WINDOW) {
    if (INJECTION_PATTERNS.APP_NAME.test(strValue)) {
      throw new Error(`Application name contains illegal characters: ${strValue}`);
    }
  }

  if (action.type === ACTION_TYPES.CLOSE_APP) {
    if (INJECTION_PATTERNS.CLOSE_APP_NAME.test(strValue)) {
      throw new Error(`Application name contains illegal characters: ${strValue}`);
    }
  }

  if (action.type === ACTION_TYPES.COMMAND && action.cwd) {
    const cwdStr = String(action.cwd).trim();
    if (cwdStr.length > BOUNDS.MAX_CWD_LENGTH) {
      throw new Error('Working directory path exceeds maximum length.');
    }
  }
}

/**
 * Validates all actions in a macro sequentially.
 * @param {Array<{ type: string, value: unknown }>} actions
 * @returns {{ ok: true } | { ok: false, stepIndex: number, error: string }}
 */
function validateAllActions(actions) {
  if (!Array.isArray(actions)) {
    return { ok: false, stepIndex: -1, error: 'Actions must be an array.' };
  }

  for (let i = 0; i < actions.length; i++) {
    try {
      validateAction(actions[i]);
    } catch (err) {
      return { ok: false, stepIndex: i, error: `Step ${i + 1}: ${err.message}` };
    }
  }

  return { ok: true };
}

module.exports = {
  ACTION_TYPES,
  TYPES,
  BOUNDS,
  ALLOWED_SNAP_POSITIONS,
  isValidId,
  interpolateVariables,
  sanitizeMacro,
  validateAction,
  validateAllActions
};
