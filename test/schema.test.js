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
  interpolateVariables,
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

  // Test 2: Sanitize Macro with hotkey, schedule, and custom variables
  const raw = {
    id: 'valid-id',
    name: '  My Setup Workflow  ',
    hotkey: ' CommandOrControl+Shift+C ',
    schedule: ' 09:00 ',
    variables: { PORT: '3000' },
    actions: [
      { type: 'wait', value: 2500 },
      { type: 'openApp', value: 'Visual Studio Code' },
      { type: 'waitForUrl', value: 'http://localhost:3000', timeout: 10000 },
      { type: 'speak', value: 'Ready!' },
      { type: 'snapWindow', value: 'Chrome', position: 'left' }
    ]
  };
  const sanitized = sanitizeMacro(raw);
  assert.strictEqual(sanitized.id, 'valid-id');
  assert.strictEqual(sanitized.name, 'My Setup Workflow');
  assert.strictEqual(sanitized.hotkey, 'CommandOrControl+Shift+C');
  assert.strictEqual(sanitized.schedule, '09:00');
  assert.strictEqual(sanitized.variables.PORT, '3000');
  assert.strictEqual(sanitized.actions.length, 5);
  assert.strictEqual(sanitized.actions[0].value, 2500);

  // Test 3: Validate Action - URL safety
  assert.doesNotThrow(() => validateAction({ type: 'openUrl', value: 'https://github.com' }));
  assert.doesNotThrow(() => validateAction({ type: 'openUrl', value: 'http://localhost:3000' }));
  assert.doesNotThrow(() => validateAction({ type: 'waitForUrl', value: 'http://localhost:3000' }));
  assert.throws(() => validateAction({ type: 'openUrl', value: 'file:///etc/passwd' }), /blocked/i);
  assert.throws(() => validateAction({ type: 'openUrl', value: 'javascript:alert(1)' }), /blocked/i);

  // Test 4: Validate Action - App name injection safety
  assert.doesNotThrow(() => validateAction({ type: 'openApp', value: 'Google Chrome' }));
  assert.doesNotThrow(() => validateAction({ type: 'snapWindow', value: 'Google Chrome', position: 'maximize' }));
  assert.throws(() => validateAction({ type: 'openApp', value: 'Chrome; rm -rf /' }), /illegal characters/i);
  assert.throws(() => validateAction({ type: 'openApp', value: 'App & Calc' }), /illegal characters/i);

  // Test 5: Validate Action - Wait bounds
  assert.doesNotThrow(() => validateAction({ type: 'wait', value: 1000 }));
  assert.throws(() => validateAction({ type: 'wait', value: -50 }), /between 0 and/i);
  assert.throws(() => validateAction({ type: 'wait', value: 99999999 }), /between 0 and/i);

  // Test 6: Validate All Actions
  const validBatch = [
    { type: 'openApp', value: 'Notes' },
    { type: 'speak', value: 'Focus time' },
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

  // Test 7: Variable interpolation
  process.env.TEST_MACRO_VAR = 'alpha';
  const tmpl = 'Hello {{USER}}, port is {{PORT}}, env is {{env.TEST_MACRO_VAR}}, date is {{DATE}}';
  const interpolated = interpolateVariables(tmpl, { PORT: '8080' });
  assert.ok(interpolated.includes('port is 8080'));
  assert.ok(interpolated.includes('env is alpha'));
  assert.ok(!interpolated.includes('{{PORT}}'));
  assert.ok(!interpolated.includes('{{DATE}}'));

  console.log('✓ All 7 Schema & Validation tests passed successfully.');
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
