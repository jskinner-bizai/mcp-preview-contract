import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPreviewContract } from '../src/index.mjs';
import { createInventoryFixture } from '../examples/inventory.mjs';
import { createTaskFixture } from '../examples/tasks.mjs';
import { closeConnections } from '../examples/support.mjs';

test('fixture cleanup attempts both connections after a synchronous close failure', async () => {
  const closed = [];
  const failure = new Error('Deliberate client-close failure');
  await assert.rejects(closeConnections(
    { close: () => { closed.push('client'); throw failure; } },
    { close: async () => { closed.push('server'); } },
  ), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure);
  assert.deepEqual(closed, ['client', 'server']);
});

test('fixture cleanup reports both failures after attempting both connections', async () => {
  const closed = [];
  await assert.rejects(closeConnections(
    { close: async () => { closed.push('client'); throw new Error('Client close failed'); } },
    { close: async () => { closed.push('server'); throw new Error('Server close failed'); } },
  ), error => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(closed, ['client', 'server']);
});

test('fixture cleanup completes when both resources close', async () => {
  const closed = [];
  await closeConnections({ close: async () => { closed.push('client'); } },
    { close: async () => { closed.push('server'); } });
  assert.deepEqual(closed, ['client', 'server']);
});

for (const [name, create] of [['inventory', createInventoryFixture], ['tasks', createTaskFixture]]) {
  test(`${name}: real MCP Client/McpServer passes every application-contract case`, async () => {
    let created = 0, closed = 0;
    const receipt = await runPreviewContract({ name, createFixture: async () => {
      created += 1;
      const fixture = await create();
      const close = fixture.close;
      fixture.close = async () => { await close(); closed += 1; };
      return fixture;
    } });
    assert.equal(receipt.passed, true, JSON.stringify(receipt, null, 2));
    assert.equal(receipt.checkCount, 10);
    assert.equal(receipt.passedCount, 10);
    assert.equal(created, 10, 'Each case must receive a fresh fixture');
    assert.equal(closed, created, 'Every SDK connection must be closed');
    assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
  });
  for (const fault of ['preview-mutation', 'preview-rollback', 'wrong-preview', 'ignore-token',
    'stale-acceptance', 'scope-ignored', 'partial-effect', 'extra-effect',
    'duplicate-replay', 'concurrent-double-write', 'error-after-mutation']) {
    test(`${name}: independent oracles detect ${fault}`, async () => {
      const receipt = await runPreviewContract({ name: `${name}-${fault}`,
        createFixture: () => create({ fault }) });
      assert.equal(receipt.passed, false, `Broken ${fault} fixture was incorrectly certified`);
      assert.ok(receipt.checks.some(check => !check.passed));
      assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
      if (fault === 'preview-rollback') {
        assert.ok(receipt.checks.some(check => !check.passed && check.mutationDelta > 0),
          'Net-state equality must not hide mutation journal entries');
      }
    });
  }
}

const project = fileURLToPath(new URL('..', import.meta.url));
for (const selection of ['inventory', 'tasks', 'all']) {
  test(`CLI: built-in ${selection} demo returns actual contract receipts`, () => {
    const child = spawnSync(process.execPath, ['bin/mcp-preview-contract.mjs', 'demo', selection],
      { cwd: project, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout);
    assert.equal(output.passed, true);
    assert.equal(output.receipts.length, selection === 'all' ? 2 : 1);
    assert.ok(output.receipts.every(receipt => receipt.passed && receipt.checkCount === 10));
    assert.match(output.disclaimer, /not MCP certification/);
    assert.equal(output.socketsOrExternalServices, false);
  });
}
for (const args of [['demo', 'https://example.invalid/mcp'], ['--command', 'untrusted-program']]) {
  test(`CLI: refuses unsupported external execution argument ${args[0]}`, () => {
    const child = spawnSync(process.execPath, ['bin/mcp-preview-contract.mjs', ...args],
      { cwd: project, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /No endpoint or command argument is supported/);
  });
}
