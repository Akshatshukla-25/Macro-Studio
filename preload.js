/**
 * @fileoverview Macro Studio Preload Security Script.
 * Securely exposes the `window.api` interface to the renderer process
 * using Electron contextBridge. Strict sandboxing and context isolation enabled.
 *
 * @author Akshat Shukla
 * @license MIT
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Validated API surface exposed to the renderer window.
 */
contextBridge.exposeInMainWorld('api', {
  /**
   * Retrieves all saved macros.
   * @returns {Promise<{ ok: boolean, macros?: Array<any>, error?: string }>}
   */
  listMacros: () => ipcRenderer.invoke('macros:list'),

  /**
   * Retrieves pre-configured workflow templates.
   * @returns {Promise<{ ok: boolean, templates?: Array<any>, error?: string }>}
   */
  getTemplates: () => ipcRenderer.invoke('macros:templates'),

  /**
   * Persists a macro (create or update).
   * @param {object} macro
   * @returns {Promise<{ ok: boolean, macro?: any, error?: string }>}
   */
  saveMacro: (macro) => ipcRenderer.invoke('macros:save', macro),

  /**
   * Deletes a macro by ID.
   * @param {string} id
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  deleteMacro: (id) => ipcRenderer.invoke('macros:delete', id),

  /**
   * Starts sequential execution of a macro.
   * @param {string} id
   * @returns {Promise<{ ok: boolean, cancelled?: boolean, error?: string }>}
   */
  runMacro: (id) => ipcRenderer.invoke('macro:run', id),

  /**
   * Aborts currently executing macro.
   */
  stopMacro: () => ipcRenderer.send('macro:stop'),

  /**
   * Submits user recovery choice on a step error.
   * @param {'retry'|'skip'|'stop'} choice
   */
  decide: (choice) => ipcRenderer.send('macro:decision', choice),

  /**
   * Subscribes to step execution status events.
   * @param {(status: { stepIndex: number, status: 'running'|'done'|'error'|'skipped', message?: string }) => void} callback
   */
  onStatus: (callback) => {
    ipcRenderer.on('macro:status', (_event, payload) => callback(payload));
  },

  /**
   * Subscribes to macro execution completion event.
   * @param {(result: { result: 'finished'|'stopped', error?: string }) => void} callback
   */
  onDone: (callback) => {
    ipcRenderer.on('macro:done', (_event, payload) => callback(payload));
  }
});
