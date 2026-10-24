/**
 * @fileoverview Macro Studio Renderer Controller & Workflow Builder.
 * Manages reactive UI rendering, the visual action signal chain, step reordering,
 * dirty state tracking, and live execution telemetry.
 *
 * @author Akshat Shukla
 * @license MIT
 */

'use strict';

/**
 * Action type visual specifications and defaults.
 */
const ACTION_DEFINITIONS = Object.freeze({
  openApp: {
    label: 'Open Application',
    icon: '🖥️',
    placeholder: 'e.g. Visual Studio Code, Slack, Chrome',
    help: 'Application executable or bundle name'
  },
  openUrl: {
    label: 'Open Website / URL',
    icon: '🌐',
    placeholder: 'https://localhost:3000',
    help: 'Must start with http:// or https://'
  },
  command: {
    label: 'Run Terminal Command',
    icon: '💻',
    placeholder: 'npm run dev',
    help: 'Executed in user shell with optional working directory'
  },
  wait: {
    label: 'Pause Duration',
    icon: '⏱️',
    placeholder: '2',
    help: 'Seconds to wait before proceeding'
  },
  notification: {
    label: 'Show Notification',
    icon: '🔔',
    placeholder: 'Development workspace ready!',
    help: 'Native OS notification message'
  },
  closeApp: {
    label: 'Close Application',
    icon: '⛔',
    placeholder: 'e.g. Chrome, Discord',
    help: 'Terminates process or closes application'
  }
});

// Shorthand DOM helper
const $ = (selector) => document.querySelector(selector);
const clone = (data) => JSON.parse(JSON.stringify(data));
const generateId = () => 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);

/**
 * Creates an element with optional CSS class and text content.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [textContent]
 * @returns {HTMLElement}
 */
function createElement(tag, className, textContent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent !== undefined) element.textContent = textContent;
  return element;
}

// Client application state
let macroList = [];
let activeMacro = null;
let isDirty = false;
let isExecuting = false;
let stepStatuses = []; // Array<{ status: 'idle'|'running'|'done'|'error'|'skipped', message?: string }>
let awaitingDecisionStep = -1;

/**
 * Appends an entry to the execution terminal log.
 * @param {string} message
 * @param {'ok'|'err'|'info'} [type='info']
 */
function appendLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const li = createElement('li', type, `[${timestamp}] ${message}`);
  const logContainer = $('#log');
  logContainer.prepend(li);
}

/**
 * Updates the unsaved changes dirty indicator.
 * @param {boolean} dirty
 */
function setDirty(dirty) {
  isDirty = dirty;
  $('#dirty').hidden = !dirty;
}

/* -------------------------------------------------------------------------- */
/*                               Sidebar Views                                */
/* -------------------------------------------------------------------------- */

function renderSidebar() {
  const container = $('#macro-list');
  container.replaceChildren();

  macroList.forEach((macro) => {
    const li = document.createElement('li');
    const isActive = Boolean(activeMacro && activeMacro.id === macro.id);
    const button = createElement('button', `macro-item${isActive ? ' active' : ''}`);

    const titleSpan = createElement('span', 'title', macro.name);
    const countBadge = createElement('small', '', `${macro.actions.length} ${macro.actions.length === 1 ? 'step' : 'steps'}`);

    button.append(titleSpan, countBadge);
    button.addEventListener('click', () => selectMacro(macro.id));

    li.appendChild(button);
    container.appendChild(li);
  });
}

function selectMacro(macroId) {
  if (isExecuting) return;
  if (isDirty && !window.confirm('You have unsaved changes. Discard and switch?')) {
    return;
  }

  const target = macroList.find((m) => m.id === macroId);
  if (!target) return;

  activeMacro = clone(target);
  stepStatuses = [];
  awaitingDecisionStep = -1;
  setDirty(false);
  renderView();
}

function createNewMacro() {
  if (isExecuting) return;
  if (isDirty && !window.confirm('You have unsaved changes. Discard and create new?')) {
    return;
  }

  activeMacro = {
    id: generateId(),
    name: 'Untitled Workflow',
    actions: []
  };

  stepStatuses = [];
  awaitingDecisionStep = -1;
  setDirty(true);
  renderView();

  const nameInput = $('#macro-name');
  nameInput.focus();
  nameInput.select();
}

/* -------------------------------------------------------------------------- */
/*                             Action Chain Editor                            */
/* -------------------------------------------------------------------------- */

function renderView() {
  const hasSelection = Boolean(activeMacro);
  $('#empty').hidden = hasSelection;
  $('#editor').hidden = !hasSelection;

  renderSidebar();
  if (!hasSelection) return;

  $('#macro-name').value = activeMacro.name;
  $('#macro-name').disabled = isExecuting;
  $('#btn-save').disabled = isExecuting;
  $('#btn-delete').disabled = isExecuting;
  $('#btn-run').hidden = isExecuting;
  $('#btn-stop').hidden = !isExecuting;
  $('#chain-empty').hidden = activeMacro.actions.length > 0;

  document.querySelectorAll('#add-bar button').forEach((btn) => {
    btn.disabled = isExecuting;
  });

  renderActionChain();
}

function renderActionChain() {
  const chainList = $('#chain');
  chainList.replaceChildren();

  activeMacro.actions.forEach((action, index) => {
    const spec = ACTION_DEFINITIONS[action.type] || { label: action.type, icon: '⚡', placeholder: '' };
    const stepState = stepStatuses[index] || { status: 'idle' };

    const li = createElement('li', `step ${stepState.status}`);

    // Status node pill with icon
    const node = createElement('span', 'node', spec.icon);
    li.appendChild(node);

    // Card body
    const card = createElement('div', 'card');

    // Card header
    const head = createElement('div', 'card-head');
    head.appendChild(createElement('span', 'kind', `${index + 1}. ${spec.label}`));

    // Controls (Move Up, Move Down, Delete)
    const ctrl = createElement('div', 'ctrl');
    const createCtrlBtn = (icon, title, onClick, disabled) => {
      const btn = createElement('button', '', icon);
      btn.type = 'button';
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.disabled = Boolean(disabled || isExecuting);
      btn.addEventListener('click', onClick);
      return btn;
    };

    ctrl.append(
      createCtrlBtn('↑', 'Move step up', () => moveStep(index, -1), index === 0),
      createCtrlBtn('↓', 'Move step down', () => moveStep(index, 1), index === activeMacro.actions.length - 1),
      createCtrlBtn('✕', 'Remove step', () => removeStep(index))
    );
    head.appendChild(ctrl);
    card.appendChild(head);

    // Primary input field
    const primaryField = createElement('div', 'field');
    const input = document.createElement('input');
    input.disabled = isExecuting;
    input.setAttribute('aria-label', `${spec.label} value`);

    if (action.type === 'wait') {
      input.type = 'number';
      input.min = '0';
      input.max = '3600';
      input.step = '0.5';
      input.className = 'num';
      input.value = String((Number(action.value) || 0) / 1000);
      input.addEventListener('input', () => {
        action.value = Math.round((parseFloat(input.value) || 0) * 1000);
        setDirty(true);
      });
      primaryField.append(input, createElement('span', 'muted', 'seconds'));
    } else {
      input.type = 'text';
      input.placeholder = spec.placeholder;
      input.value = String(action.value || '');
      if (action.type === 'command') input.className = 'mono';
      input.addEventListener('input', () => {
        action.value = input.value;
        setDirty(true);
      });
      primaryField.appendChild(input);
    }
    card.appendChild(primaryField);

    // Secondary working directory field for commands
    if (action.type === 'command') {
      const cwdField = createElement('div', 'field');
      const cwdInput = document.createElement('input');
      cwdInput.type = 'text';
      cwdInput.className = 'mono';
      cwdInput.placeholder = 'Working directory path (optional)';
      cwdInput.value = action.cwd || '';
      cwdInput.disabled = isExecuting;
      cwdInput.setAttribute('aria-label', 'Working directory');
      cwdInput.addEventListener('input', () => {
        action.cwd = cwdInput.value;
        setDirty(true);
      });
      cwdField.appendChild(cwdInput);
      card.appendChild(cwdField);
    }

    // Step error message & interactive recovery controls
    if (stepState.status === 'error') {
      card.appendChild(createElement('div', 'msg err', stepState.message || 'Execution failed at this step.'));

      if (awaitingDecisionStep === index) {
        const decisionRow = createElement('div', 'decide');
        const options = [
          ['↺ Retry Step', 'retry'],
          ['↷ Skip Step', 'skip'],
          ['■ Abort Workflow', 'stop']
        ];

        options.forEach(([labelText, choiceCode]) => {
          const btn = createElement('button', 'btn', labelText);
          btn.addEventListener('click', () => {
            awaitingDecisionStep = -1;
            window.api.decide(choiceCode);
          });
          decisionRow.appendChild(btn);
        });

        card.appendChild(decisionRow);
      }
    }

    li.appendChild(card);
    chainList.appendChild(li);
  });
}

function addStep(type) {
  if (isExecuting || !activeMacro) return;
  activeMacro.actions.push(type === 'wait' ? { type, value: 2000 } : { type, value: '' });
  setDirty(true);
  renderView();

  const inputs = document.querySelectorAll('#chain input');
  const targetInput = [...inputs].reverse().find((inp) => !inp.placeholder.includes('Working directory'));
  if (targetInput) targetInput.focus();
}

function moveStep(currentIndex, direction) {
  const newIndex = currentIndex + direction;
  if (newIndex < 0 || newIndex >= activeMacro.actions.length) return;

  const temp = activeMacro.actions[currentIndex];
  activeMacro.actions[currentIndex] = activeMacro.actions[newIndex];
  activeMacro.actions[newIndex] = temp;

  setDirty(true);
  renderView();
}

function removeStep(index) {
  if (isExecuting || !activeMacro) return;
  activeMacro.actions.splice(index, 1);
  setDirty(true);
  renderView();
}

/* -------------------------------------------------------------------------- */
/*                           Persistence Operations                           */
/* -------------------------------------------------------------------------- */

async function saveMacro() {
  if (!activeMacro) return false;
  activeMacro.name = $('#macro-name').value.trim() || 'Untitled Workflow';

  const res = await window.api.saveMacro(clone(activeMacro));
  if (!res.ok) {
    appendLog(`Failed to save: ${res.error}`, 'err');
    return false;
  }

  activeMacro = clone(res.macro);
  const existingIdx = macroList.findIndex((m) => m.id === activeMacro.id);
  if (existingIdx >= 0) {
    macroList[existingIdx] = clone(res.macro);
  } else {
    macroList.push(clone(res.macro));
  }

  setDirty(false);
  renderView();
  appendLog(`Saved "${activeMacro.name}" successfully.`, 'ok');
  return true;
}

async function deleteMacro() {
  if (!activeMacro) return;
  if (!window.confirm(`Are you sure you want to delete "${activeMacro.name}"? This cannot be undone.`)) {
    return;
  }

  const res = await window.api.deleteMacro(activeMacro.id);
  if (!res.ok) {
    appendLog(`Failed to delete: ${res.error}`, 'err');
    return;
  }

  macroList = macroList.filter((m) => m.id !== activeMacro.id);
  activeMacro = macroList.length > 0 ? clone(macroList[0]) : null;
  stepStatuses = [];
  awaitingDecisionStep = -1;
  setDirty(false);
  renderView();
}

/* -------------------------------------------------------------------------- */
/*                            Execution Orchestration                         */
/* -------------------------------------------------------------------------- */

async function runCurrentMacro() {
  if (isExecuting || !activeMacro) return;
  if (activeMacro.actions.length === 0) {
    appendLog('Cannot run an empty workflow. Add at least one action.', 'err');
    return;
  }

  const saved = await saveMacro();
  if (!saved) return;

  stepStatuses = [];
  awaitingDecisionStep = -1;
  isExecuting = true;
  renderView();

  appendLog(`Executing workflow "${activeMacro.name}"...`, 'info');

  const res = await window.api.runMacro(activeMacro.id);
  if (!res.ok) {
    isExecuting = false;
    renderView();
    if (res.cancelled) {
      appendLog('Workflow cancelled by user.', 'info');
    } else {
      appendLog(`Execution error: ${res.error}`, 'err');
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                             IPC Event Listeners                            */
/* -------------------------------------------------------------------------- */

window.api.onStatus((payload) => {
  const index = payload.stepIndex !== undefined ? payload.stepIndex : payload.index;
  const status = payload.status || payload.state;
  const message = payload.message;

  stepStatuses[index] = { status, message };
  awaitingDecisionStep = status === 'error' ? index : (awaitingDecisionStep === index ? -1 : awaitingDecisionStep);

  const action = activeMacro && activeMacro.actions[index];
  if (action) {
    const spec = ACTION_DEFINITIONS[action.type];
    const label = spec ? spec.label : action.type;

    if (status === 'error') {
      appendLog(`Step ${index + 1} (${label}) failed: ${message}`, 'err');
    } else if (status === 'done') {
      appendLog(`Step ${index + 1} (${label}) completed`, 'ok');
    } else if (status === 'skipped') {
      appendLog(`Step ${index + 1} (${label}) skipped by user`);
    }
  }

  renderActionChain();

  const stepElements = document.querySelectorAll('#chain .step');
  if (stepElements[index]) {
    stepElements[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

window.api.onDone(({ result, error }) => {
  isExecuting = false;
  awaitingDecisionStep = -1;
  renderView();

  if (result === 'finished') {
    appendLog(`Workflow "${activeMacro ? activeMacro.name : ''}" completed successfully!`, 'ok');
  } else {
    appendLog(`Workflow stopped${error ? ': ' + error : '.'}`, 'err');
  }
});

/* -------------------------------------------------------------------------- */
/*                              Keyboard Shortcuts                            */
/* -------------------------------------------------------------------------- */

document.addEventListener('keydown', (event) => {
  const isMeta = event.metaKey || event.ctrlKey;
  if (isMeta && event.key === 's') {
    event.preventDefault();
    saveMacro();
  } else if (isMeta && event.key === 'Enter') {
    event.preventDefault();
    if (!isExecuting) runCurrentMacro();
  } else if (event.key === 'Escape') {
    if (isExecuting) {
      window.api.stopMacro();
    }
  }
});

/* -------------------------------------------------------------------------- */
/*                               Initialization                               */
/* -------------------------------------------------------------------------- */

async function openTemplateModal() {
  const dialog = $('#template-dialog');
  const container = $('#template-list');
  container.replaceChildren();

  const res = await window.api.getTemplates();
  const templates = res.ok && Array.isArray(res.templates) ? res.templates : [];

  templates.forEach((tmpl) => {
    const card = createElement('button', 'template-card');
    card.type = 'button';

    const h3 = createElement('h3', '', tmpl.name);
    const p = createElement('p', '', tmpl.description);
    const badge = createElement('span', 'steps-count', `${tmpl.actions.length} automated steps`);

    card.append(h3, p, badge);
    card.addEventListener('click', () => {
      dialog.close();
      loadTemplateAsNew(tmpl);
    });

    container.appendChild(card);
  });

  dialog.showModal();
}

function loadTemplateAsNew(tmpl) {
  if (isExecuting) return;
  if (isDirty && !window.confirm('You have unsaved changes. Discard and load template?')) {
    return;
  }

  activeMacro = {
    id: generateId(),
    name: tmpl.name,
    actions: clone(tmpl.actions)
  };

  stepStatuses = [];
  awaitingDecisionStep = -1;
  setDirty(true);
  renderView();
  appendLog(`Loaded template "${tmpl.name}". Review steps and click Save.`, 'info');
}

function initializeApp() {
  const addBar = $('#add-bar');
  Object.entries(ACTION_DEFINITIONS).forEach(([type, spec]) => {
    const btn = createElement('button', 'btn', `${spec.icon} ${spec.label}`);
    btn.type = 'button';
    btn.addEventListener('click', () => addStep(type));
    addBar.appendChild(btn);
  });

  $('#btn-new').addEventListener('click', createNewMacro);
  $('#btn-templates').addEventListener('click', openTemplateModal);
  $('#btn-close-dialog').addEventListener('click', () => $('#template-dialog').close());
  $('#btn-save').addEventListener('click', saveMacro);
  $('#btn-delete').addEventListener('click', deleteMacro);
  $('#btn-run').addEventListener('click', runCurrentMacro);
  $('#btn-stop').addEventListener('click', () => window.api.stopMacro());

  $('#macro-name').addEventListener('input', (event) => {
    if (activeMacro) {
      activeMacro.name = event.target.value;
      setDirty(true);
    }
  });

  window.api.listMacros().then((res) => {
    macroList = res.ok && Array.isArray(res.macros) ? res.macros : [];
    activeMacro = macroList.length > 0 ? clone(macroList[0]) : null;
    renderView();
  });
}

// Bootstrap renderer
initializeApp();
