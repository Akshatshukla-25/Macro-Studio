/**
 * @fileoverview Crash-Resilient Storage Manager for Macro Studio.
 * Handles persistence of automation workflows and command security approval hashes.
 * Implements atomic writes (temp file + atomic rename) and automatic recovery
 * from corrupted files.
 *
 * @author Akshat Shukla
 * @license MIT
 */

'use strict';

const fs = require('fs/promises');
const path = require('path');
const { sanitizeMacro } = require('./schema');

/**
 * File paths for persistent storage.
 * @type {{ baseDir: string|null, macrosFile: string|null, approvalsFile: string|null }}
 */
const paths = {
  baseDir: null,
  macrosFile: null,
  approvalsFile: null
};

/**
 * Mutex queue to prevent overlapping write operations.
 * @type {Promise<void>}
 */
let writeQueue = Promise.resolve();

/**
 * Generates an URL-safe unique macro identifier.
 * @returns {string}
 */
function makeId() {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

/**
 * Safely reads a JSON file from disk. If the file is missing, returns fallback.
 * If corrupted, creates a recovery backup and returns fallback.
 *
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return fallback;
    }
    if (err instanceof SyntaxError) {
      console.error(`[Storage] Corrupt JSON detected in ${filePath}. Backing up...`);
      try {
        const backupPath = `${filePath}.corrupt.${Date.now()}`;
        await fs.rename(filePath, backupPath);
        console.warn(`[Storage] Corrupt file moved to: ${backupPath}`);
      } catch (backupErr) {
        console.error('[Storage] Failed to backup corrupt file:', backupErr);
      }
      return fallback;
    }
    throw err;
  }
}

/**
 * Atomically writes data to disk via temporary file swap.
 * Guaranteed serial execution through a promise chain.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @returns {Promise<void>}
 */
function writeJson(filePath, data) {
  writeQueue = writeQueue.then(async () => {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, filePath);
  });
  return writeQueue;
}

/**
 * Default seeded workflow for new installations.
 */
const DEFAULT_SEED_WORKFLOW = Object.freeze([
  {
    id: 'm_seed_coding',
    name: 'Start Coding',
    actions: [
      { type: 'openApp', value: 'Visual Studio Code' },
      { type: 'wait', value: 2000 },
      { type: 'openUrl', value: 'http://localhost:3000' },
      { type: 'command', value: 'npm run dev' },
      { type: 'wait', value: 3000 },
      { type: 'notification', value: 'Development environment ready!' }
    ]
  }
]);

/**
 * Initializes the storage directory and seeds initial workflow if empty.
 * @param {string} storageDir Target directory (typically app.getPath('userData')).
 * @returns {Promise<void>}
 */
async function init(storageDir) {
  paths.baseDir = storageDir;
  paths.macrosFile = path.join(storageDir, 'macros.json');
  paths.approvalsFile = path.join(storageDir, 'approvals.json');

  await fs.mkdir(storageDir, { recursive: true });

  const existing = await readJson(paths.macrosFile, null);
  if (existing === null || !Array.isArray(existing) || existing.length === 0) {
    await writeJson(paths.macrosFile, DEFAULT_SEED_WORKFLOW);
  }
}

/**
 * Retrieves the list of all saved macros.
 * @returns {Promise<Array<{ id: string, name: string, actions: Array<any> }>>}
 */
async function list() {
  if (!paths.macrosFile) {
    throw new Error('Storage layer has not been initialized.');
  }
  return readJson(paths.macrosFile, []);
}

/**
 * Saves a new macro or updates an existing one.
 * Automatically sanitizes inputs.
 *
 * @param {object} macro
 * @returns {Promise<{ id: string, name: string, actions: Array<any> }>}
 */
async function save(macro) {
  if (!paths.macrosFile) {
    throw new Error('Storage layer has not been initialized.');
  }

  const clean = sanitizeMacro(macro, makeId);
  const all = await list();
  const existingIdx = all.findIndex((m) => m.id === clean.id);

  if (existingIdx >= 0) {
    all[existingIdx] = clean;
  } else {
    all.push(clean);
  }

  await writeJson(paths.macrosFile, all);
  return clean;
}

/**
 * Deletes a macro by ID and purges its stored approval hash.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function remove(id) {
  if (!paths.macrosFile || !paths.approvalsFile) {
    throw new Error('Storage layer has not been initialized.');
  }

  const remaining = (await list()).filter((m) => m.id !== id);
  await writeJson(paths.macrosFile, remaining);

  const approvals = await getApprovals();
  if (Object.prototype.hasOwnProperty.call(approvals, id)) {
    delete approvals[id];
    await writeJson(paths.approvalsFile, approvals);
  }
}

/**
 * Returns all saved command approval hashes.
 * @returns {Promise<Record<string, string>>}
 */
async function getApprovals() {
  if (!paths.approvalsFile) {
    return {};
  }
  return readJson(paths.approvalsFile, {});
}

/**
 * Registers an approved command set hash for a macro.
 * @param {string} macroId
 * @param {string} commandHash SHA-256 hash of approved commands.
 * @returns {Promise<void>}
 */
async function setApproval(macroId, commandHash) {
  if (!paths.approvalsFile) {
    throw new Error('Storage layer has not been initialized.');
  }

  const approvals = await getApprovals();
  approvals[macroId] = commandHash;
  await writeJson(paths.approvalsFile, approvals);
}

module.exports = {
  init,
  list,
  save,
  remove,
  getApprovals,
  setApproval,
  makeId,
  readJson,
  writeJson
};
