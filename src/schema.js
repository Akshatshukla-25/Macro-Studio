/**
 * @fileoverview Macro Studio Data Contract & Validation Engine.
 * Provides runtime sanitization, parameter boundary validation,
 * and security defenses against injection for desktop macro actions.
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
  CLOSE_APP: 'closeApp'
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
 * Sanitizes a raw macro object for safe persistence.
 * Permissive during draft editing (allows empty values), but strictly bounds lengths
 * and strips unwanted properties.
 *
 * @param {unknown} raw
 * @param {() => string} generateId Fallback identifier generator.
 * @returns {{ id: string, name: string, actions: Array<{ type: string, value: string|number, cwd?: string }> }}
 * @throws {TypeError|RangeError} On fundamentally invalid structural input.
 */
function sanitizeMacro(raw, generateId = () => `macro-${Date.now()}`) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Invalid macro: payload must be a non-null object.');
  }

  const id = isValidId(raw.id) ? raw.id : generateId();
  const name = String(raw.name ?? '').trim().slice(0, BOUNDS.MAX_NAME_LENGTH) || 'Untitled macro';

  if (!Array.isArray(raw.actions)) {
    throw new TypeError('Invalid macro: actions must be an array.');
  }

  if (raw.actions.length > BOUNDS.MAX_ACTIONS) {
    throw new RangeError(`A macro cannot exceed ${BOUNDS.MAX_ACTIONS} actions.`);
  }

  const actions = raw.actions.map((act, index) => {
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

    return sanitized;
  });

  return { id, name, actions };
}

/**
 * Validates a single action before execution.
 * Enforces strict values, valid protocols, and injection safety.
 *
 * @param {{ type: string, value: unknown, cwd?: unknown }} action
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

  if (action.type === ACTION_TYPES.OPEN_URL) {
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

  if (action.type === ACTION_TYPES.OPEN_APP) {
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
  isValidId,
  sanitizeMacro,
  validateAction,
  validateAllActions
};
