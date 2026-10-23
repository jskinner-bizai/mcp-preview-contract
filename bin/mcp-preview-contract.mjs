#!/usr/bin/env node
import { runPreviewContract } from '../src/index.mjs';
import { createInventoryFixture } from '../examples/inventory.mjs';
import { createTaskFixture } from '../examples/tasks.mjs';

const args = process.argv.slice(2);
if (args[0] !== 'demo' || args.length > 2 || (args[1] && !['inventory', 'tasks', 'all'].includes(args[1]))) {
  console.error('Usage: node bin/mcp-preview-contract.mjs demo [inventory|tasks|all]');
  console.error('Runs disposable, in-process synthetic fixtures only. No endpoint or command argument is supported.');
  process.exitCode = 2;
} else {
  const selected = args[1] ?? 'all';
  const entries = [['inventory', createInventoryFixture], ['tasks', createTaskFixture]]
    .filter(([name]) => selected === 'all' || name === selected);
  const receipts = [];
  try {
    for (const [name, createFixture] of entries) receipts.push(await runPreviewContract({ name, createFixture }));
    const result = { applicationContract: 'preview-confirm-v1',
      disclaimer: 'Disposable-fixture application checks, not MCP certification or a production security guarantee.',
      realMcpSdk: true, socketsOrExternalServices: false,
      passed: receipts.every(receipt => receipt.passed), receipts };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    console.error('Demo could not complete. No automatic retry was attempted; inspect the local test setup.');
    process.exitCode = 1;
  }
}
