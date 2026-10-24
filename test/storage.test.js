/**
 * @fileoverview Unit tests for Macro Studio Storage Layer.
 */

'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const storage = require('../src/storage');

async function runTests() {
  console.log('--- Running Storage Layer Tests ---');
  const testDir = path.join(os.tmpdir(), `macro-studio-test-${Date.now()}`);

  try {
    // Test 1: Initialization
    await storage.init(testDir);
    const initialList = await storage.list();
    assert.strictEqual(initialList.length, 1);
    assert.strictEqual(initialList[0].name, 'Start Coding');

    // Test 2: Save new macro
    const newMacro = await storage.save({
      name: 'Test Workflow',
      actions: [{ type: 'wait', value: 1000 }]
    });
    assert.ok(newMacro.id);
    const listAfterSave = await storage.list();
    assert.strictEqual(listAfterSave.length, 2);

    // Test 3: Update existing macro
    newMacro.name = 'Renamed Workflow';
    await storage.save(newMacro);
    const listAfterUpdate = await storage.list();
    const updated = listAfterUpdate.find((m) => m.id === newMacro.id);
    assert.strictEqual(updated.name, 'Renamed Workflow');

    // Test 4: Approval hash tracking
    await storage.setApproval(newMacro.id, 'hash_abc123');
    let approvals = await storage.getApprovals();
    assert.strictEqual(approvals[newMacro.id], 'hash_abc123');

    // Test 5: Delete macro and verify approval hash is purged
    await storage.remove(newMacro.id);
    const listAfterRemove = await storage.list();
    assert.strictEqual(listAfterRemove.length, 1);
    approvals = await storage.getApprovals();
    assert.strictEqual(approvals[newMacro.id], undefined);

    // Test 6: Corrupted JSON recovery
    const macrosPath = path.join(testDir, 'macros.json');
    await fs.writeFile(macrosPath, '{ corrupted broken json content', 'utf8');
    const recoveredList = await storage.list();
    assert.deepStrictEqual(recoveredList, []); // Gracefully recovers to fallback

    console.log('✓ All 6 Storage Layer tests passed successfully.');
  } finally {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Storage test failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
