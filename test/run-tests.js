/**
 * @fileoverview Test suite aggregator for Macro Studio.
 */

'use strict';

const schemaTests = require('./schema.test');
const storageTests = require('./storage.test');
const engineTests = require('./macroEngine.test');

async function runAll() {
  console.log('==============================================');
  console.log('       MACRO STUDIO TEST SUITE RUNNER         ');
  console.log('==============================================\n');

  schemaTests.runTests();
  console.log();
  await storageTests.runTests();
  console.log();
  await engineTests.runTests();

  console.log('\n==============================================');
  console.log('       ALL INTEGRATION TESTS PASSED!          ');
  console.log('==============================================');
}

runAll().catch((err) => {
  console.error('\nTest Suite Failed:', err);
  process.exit(1);
});
