import test from 'node:test';
import assert from 'node:assert/strict';
import { saveWorklistMerged, saveSymbolIndexMerged } from '../cli/enrich-queue.mjs';

// --- saveWorklistMerged ---

test('saveWorklistMerged: disk=enriched, mem=subagent-queued → adopts disk, mutates array in-place', async () => {
  const diskEnriched = { symbolKey: 'k1', status: 'enriched', memoryId: 'mid-1', enrichedAt: '2024-01-01T00:00:00Z' };
  let savedData;
  const mockLoad = async () => [diskEnriched];
  const mockSave = async (_path, data) => { savedData = data; };
  const memWorklist = [{ symbolKey: 'k1', status: 'subagent-queued' }];
  await saveWorklistMerged('/fake/worklist.json', memWorklist, { loadJson: mockLoad, saveJson: mockSave });
  // Written array should have the enriched entry
  assert.equal(savedData[0].status, 'enriched');
  assert.equal(savedData[0].memoryId, 'mid-1');
  // In-memory array mutated in place
  assert.equal(memWorklist[0].status, 'enriched');
  assert.equal(memWorklist[0].memoryId, 'mid-1');
});

test('saveWorklistMerged: disk=pending, mem=enriched → mem wins (no downgrade)', async () => {
  const diskEntry = { symbolKey: 'k1', status: 'pending' };
  let savedData;
  const mockLoad = async () => [diskEntry];
  const mockSave = async (_path, data) => { savedData = data; };
  const memWorklist = [{ symbolKey: 'k1', status: 'enriched', memoryId: 'mid-1' }];
  await saveWorklistMerged('/fake/worklist.json', memWorklist, { loadJson: mockLoad, saveJson: mockSave });
  assert.equal(savedData[0].status, 'enriched');
  assert.equal(memWorklist[0].status, 'enriched');
});

test('saveWorklistMerged: symbol only in memory → written unchanged', async () => {
  let savedData;
  const mockLoad = async () => [];
  const mockSave = async (_path, data) => { savedData = data; };
  const memWorklist = [{ symbolKey: 'k2', status: 'pending' }];
  await saveWorklistMerged('/fake/worklist.json', memWorklist, { loadJson: mockLoad, saveJson: mockSave });
  assert.equal(savedData[0].symbolKey, 'k2');
  assert.equal(savedData[0].status, 'pending');
});

test('saveWorklistMerged: disk file missing → writes mem without error', async () => {
  let savedData;
  const mockLoad = async () => { throw new Error('ENOENT'); };
  const mockSave = async (_path, data) => { savedData = data; };
  const memWorklist = [{ symbolKey: 'k1', status: 'pending' }];
  await assert.doesNotReject(saveWorklistMerged('/fake/worklist.json', memWorklist, { loadJson: mockLoad, saveJson: mockSave }));
  assert.equal(savedData[0].status, 'pending');
});

test('saveWorklistMerged: disk=enriched, mem=already_enriched → keeps already_enriched (no overwrite)', async () => {
  const diskEnriched = { symbolKey: 'k1', status: 'enriched', memoryId: 'disk-mid' };
  let savedData;
  const mockLoad = async () => [diskEnriched];
  const mockSave = async (_path, data) => { savedData = data; };
  const memWorklist = [{ symbolKey: 'k1', status: 'already_enriched', memoryId: 'mem-mid' }];
  await saveWorklistMerged('/fake/worklist.json', memWorklist, { loadJson: mockLoad, saveJson: mockSave });
  // already_enriched is terminal — should NOT be overwritten by disk enriched
  assert.equal(savedData[0].memoryId, 'mem-mid');
});

// --- saveSymbolIndexMerged ---

test('saveSymbolIndexMerged: disk=enriched, mem=error → disk wins', async () => {
  const diskIndex = { 'k1': { status: 'enriched', memoryId: 'mid-1' } };
  let savedData;
  const mockLoad = async () => diskIndex;
  const mockSave = async (_path, data) => { savedData = data; };
  const memIndex = { k1: { status: 'error', memoryId: null } };
  await saveSymbolIndexMerged('/fake/symbol-index.json', memIndex, { loadJson: mockLoad, saveJson: mockSave });
  assert.equal(savedData.k1.status, 'enriched');
  assert.equal(savedData.k1.memoryId, 'mid-1');
  // In-memory object mutated
  assert.equal(memIndex.k1.status, 'enriched');
});

test('saveSymbolIndexMerged: disk=error, mem=enriched → mem wins', async () => {
  const diskIndex = { 'k1': { status: 'error', memoryId: null } };
  let savedData;
  const mockLoad = async () => diskIndex;
  const mockSave = async (_path, data) => { savedData = data; };
  const memIndex = { k1: { status: 'enriched', memoryId: 'mid-1' } };
  await saveSymbolIndexMerged('/fake/symbol-index.json', memIndex, { loadJson: mockLoad, saveJson: mockSave });
  assert.equal(savedData.k1.status, 'enriched');
});

test('saveSymbolIndexMerged: symbolIndexFile empty string → no-op (does not throw)', async () => {
  const mockSave = async () => { throw new Error('should not be called'); };
  await assert.doesNotReject(saveSymbolIndexMerged('', {}, { saveJson: mockSave }));
});

test('saveSymbolIndexMerged: disk file missing → writes mem without error', async () => {
  let savedData;
  const mockLoad = async () => { throw new Error('ENOENT'); };
  const mockSave = async (_path, data) => { savedData = data; };
  const memIndex = { k1: { status: 'pending' } };
  await assert.doesNotReject(saveSymbolIndexMerged('/fake/symbol-index.json', memIndex, { loadJson: mockLoad, saveJson: mockSave }));
  assert.equal(savedData.k1.status, 'pending');
});
