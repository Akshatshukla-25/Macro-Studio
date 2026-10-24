/**
 * @fileoverview Unit tests for Macro Studio Schema Validation Engine.
 */

'use strict';

const assert = require('assert');
const {
  ACTION_TYPES,
  TYPES,
  BOUNDS,
  isValidId,
  sanitizeMacro,
  validateAction,
  validateAllActions
} = require('../src/schema');

function runTests() {
  console.log('--- Running Schema & Validation Tests ---');

  // Test 1: ID validation
  assert.strictEqual(isValidId('coding-macro-1'), true);
  assert.strictEqual(isValidId('invalid id with spaces'), false);
  assert.strictEqual(isValidId(123), false);

  // Test 2: Sanitize Macro
  const raw = {
    id: 'valid-id',
    name: '  My Setup Workflow  ',
    actions: [
      { type: 'wait', value: 2500 },
      { type: 'openApp', value: 'Visual Studio Code' },
      { type: 'command', value: 'npm run dev', cwd: '/tmp' }
    ]
  };
  const sanitized = sanitizeMacro(raw);
  assert.strictEqual(sanitized.id, 'valid-id');
  assert.strictEqual(sanitized.name, 'My Setup Workflow');
  assert.strictEqual(sanitized.actions.length, 3);
  assert.strictEqual(sanitized.actions[0].value, 2500);

  // Test 3: Validate Action - URL safety
  assert.doesNotThrow(() => validateAction({ type: 'openUrl', value: 'https://github.com' }));
  assert.doesNotThrow(() => validateAction({ type: 'openUrl', value: 'http://localhost:3000' }));
  assert.throws(() => validateAction({ type: 'openUrl', value: 'file:///etc/passwd' }), /blocked/i);
  assert.throws(() => validateAction({ type: 'openUrl', value: 'javascript:alert(1)' }), /blocked/i);

  // Test 4: Validate Action - App name injection safety
  assert.doesNotThrow(() => validateAction({ type: 'openApp', value: 'Google Chrome' }));
  assert.throws(() => validateAction({ type: 'openApp', value: 'Chrome; rm -rf /' }), /illegal characters/i);
  assert.throws(() => validateAction({ type: 'openApp', value: 'App & Calc' }), /illegal characters/i);

  // Test 5: Validate Action - Wait bounds
  assert.doesNotThrow(() => validateAction({ type: 'wait', value: 1000 }));
  assert.throws(() => validateAction({ type: 'wait', value: -50 }), /between 0 and/i);
  assert.throws(() => validateAction({ type: 'wait', value: 99999999 }), /between 0 and/i);

  // Test 6: Validate All Actions
  const validBatch = [
    { type: 'openApp', value: 'Notes' },
    { type: 'wait', value: 1500 }
  ];
  const invalidBatch = [
    { type: 'openApp', value: 'Notes' },
    { type: 'openUrl', value: 'bad-url' }
  ];
  assert.deepStrictEqual(validateAllActions(validBatch), { ok: true });
  const result = validateAllActions(invalidBatch);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.stepIndex, 1);

  console.log('✓ All 6 Schema & Validation tests passed successfully.');
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
