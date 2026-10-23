import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
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


for (const [name, create] of [['inventory', createInventoryFixture], ['tasks', createTaskFixture]]) {
  test(`${name}: delayed write after preview is caught during observation window`, async () => {
    const receipt = await runPreviewContract({ name: `${name}-delayed-preview-write`,
      createFixture: () => create({ fault: 'delayed-preview-write' }), observationWindowMs: 100 });
    const preview = receipt.checks.find(check => check.name === 'preview_read_only');
    assert.equal(receipt.passed, false, 'Delayed write after preview must fail');
    assert.equal(preview.passed, false);
    assert.equal(preview.finalObservationChanged, true);
    assert.ok(preview.mutationDelta > 0, 'Journal must record the delayed write');
    assert.ok(preview.observations.length > 1, 'Multiple observations should occur during window');
    assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
  });

  test(`${name}: delayed rollback after preview is caught by journal`, async () => {
    const receipt = await runPreviewContract({ name: `${name}-delayed-preview-rollback`,
      createFixture: () => create({ fault: 'delayed-preview-rollback' }), observationWindowMs: 100 });
    const preview = receipt.checks.find(check => check.name === 'preview_read_only');
    assert.equal(receipt.passed, false, 'Delayed rollback after preview must fail');
    assert.equal(preview.passed, false);
    assert.equal(preview.mutationDelta, 2, 'Journal must show both write and rollback');
    assert.equal(preview.beforeStateSha256, preview.afterStateSha256, 'State hash returns to original');
    assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
  });

  test(`${name}: delayed write after rejection is caught during observation window`, async () => {
    const receipt = await runPreviewContract({ name: `${name}-delayed-error-write`,
      createFixture: () => create({ fault: 'delayed-error-write' }), observationWindowMs: 100 });
    const missing = receipt.checks.find(check => check.name === 'missing_token');
    assert.equal(receipt.passed, false, 'Delayed write after rejection must fail');
    assert.equal(missing.passed, false);
    assert.equal(missing.finalObservationChanged, true);
    assert.ok(missing.mutationDelta > 0, 'Journal must record the delayed write after rejection');
    assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
  });

  test(`${name}: write near end of observation window is caught with final observation`, async () => {
    const receipt = await runPreviewContract({ name: `${name}-late-window-write`,
      createFixture: () => create({ fault: 'delayed-preview-late-write' }), observationWindowMs: 50 });
    const preview = receipt.checks.find(check => check.name === 'preview_read_only');
    assert.equal(receipt.passed, false, 'Write at 45ms in 50ms window must fail');
    assert.equal(preview.passed, false);
    assert.equal(preview.finalObservationChanged, true);
    assert.ok(preview.mutationDelta > 0, 'Journal must record the late write');
    const finalOrLast = preview.observations.filter(obs =>
      obs.phase === 'final-observation-after-window' || obs.phase.startsWith('observation-poll'));
    assert.ok(finalOrLast.length > 0, 'Must have observations during/after window');
    assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
  });
}

// These phases describe scenario operations, before the final audit begins.
// Count actual observer invocations as well as receipt entries: a renamed or
// unrecorded extra final snapshot must not evade the zero-window assertion.
const scenarioObservationPhases = new Set([
  'initial', 'before-preview', 'after-preview', 'before-confirmation',
  'after-confirmation', 'after-discovery', 'after-unreviewed-request',
  'after-scope-change', 'after-independent-change', 'after-stale-rejection',
  'before-duplicate', 'after-duplicate', 'before-concurrent-confirmations',
  'after-concurrent-confirmations',
]);
const ordinaryObservations = check => check.observations.filter(
  observation => scenarioObservationPhases.has(observation.phase));

function tracedInventoryFactory(records, { onSnapshot, beforeClose } = {}) {
  return async () => {
    const fixtureIndex = records.length;
    const record = { calls: [], snapshotsBeforeClose: undefined, closed: false };
    records.push(record);
    const fixture = await createInventoryFixture();
    const originalSnapshot = fixture.observer.snapshot;
    fixture.observer.snapshot = async () => {
      const call = { startedAt: performance.now(), completedAt: undefined };
      record.calls.push(call);
      await onSnapshot?.({ fixtureIndex, callNumber: record.calls.length, record });
      const observed = await originalSnapshot();
      call.completedAt = performance.now();
      return observed;
    };
    const originalClose = fixture.close;
    fixture.close = async () => {
      record.snapshotsBeforeClose = record.calls.length;
      await beforeClose?.({ fixtureIndex, record });
      await originalClose();
      record.closed = true;
    };
    return fixture;
  };
}

test('zero observation window invokes exactly one final snapshot per fixture', async () => {
  const records = [];
  const receipt = await runPreviewContract({ name: 'inventory-zero-window',
    createFixture: tracedInventoryFactory(records), observationWindowMs: 0 });
  assert.equal(receipt.passed, true);
  assert.equal(records.length, receipt.checkCount);
  for (const [index, check] of receipt.checks.entries()) {
    const record = records[index];
    const ordinaryCount = ordinaryObservations(check).length;
    assert.equal(record.closed, true);
    assert.equal(record.snapshotsBeforeClose - ordinaryCount, 1,
      check.name + ': the observer must be called exactly once for the final audit');
    assert.equal(check.observations.length - ordinaryCount, 1,
      check.name + ': every final audit snapshot must be represented once');
    assert.equal(record.snapshotsBeforeClose, check.observations.length,
      check.name + ': no extra snapshot call may be hidden from the receipt');
  }
});

test('bounded observation window respects maximum duration', async () => {
  const start = performance.now();
  const receipt = await runPreviewContract({ name: 'inventory-bounded-window',
    createFixture: createInventoryFixture, observationWindowMs: 30 });
  const elapsed = performance.now() - start;
  assert.equal(receipt.passed, true);
  assert.ok(elapsed < 5000, 'Observation window must not turn into unbounded wait');
});

test('a slow final-audit observer completes within its bounded budget', async () => {
  const records = [];
  let slowObservationCount = 0;
  const createFixture = tracedInventoryFactory(records, {
    onSnapshot: async ({ fixtureIndex, callNumber }) => {
      // Discovery has two ordinary reads: initial and after-discovery. Only its
      // final audit is slowed; counters belong to each new disposable fixture.
      if (fixtureIndex === 0 && callNumber >= 3) {
        slowObservationCount += 1;
        await delay(35);
      }
    },
  });
  const start = performance.now();
  const receipt = await runPreviewContract({ name: 'slow-observer-bounded',
    createFixture, observationWindowMs: 40, timeoutMs: 200 });
  const elapsed = performance.now() - start;
  assert.equal(receipt.passed, true, JSON.stringify(receipt.checks[0]));
  assert.ok(slowObservationCount > 0, 'A final audit must actually encounter the slow observer');
  assert.equal(ordinaryObservations(receipt.checks[0]).length, 2);
  assert.equal(records[0].snapshotsBeforeClose - 2, slowObservationCount);
  assert.ok(records.every(record => record.closed), 'Every fixture must be closed');
  assert.ok(elapsed < 5000, 'Slow final observations must not cause an unbounded wait');
});

test('an observer stuck on the final audit fails that case and still closes every fixture', async () => {
  const records = [];
  let stuckCount = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const createFixture = tracedInventoryFactory(records, {
    onSnapshot: async ({ fixtureIndex, callNumber }) => {
      if (fixtureIndex === 0 && callNumber === 3) {
        stuckCount += 1;
        await blocked; // Remains stuck until cleanup, rather than a fixed delay.
      }
    },
    beforeClose: ({ fixtureIndex }) => { if (fixtureIndex === 0) release(); },
  });
  const start = performance.now();
  const receipt = await runPreviewContract({ name: 'stuck-observer-bounded',
    createFixture, observationWindowMs: 30, timeoutMs: 80 });
  const elapsed = performance.now() - start;
  assert.equal(stuckCount, 1, 'The first fixture must stall specifically on its final audit');
  assert.equal(receipt.checks[0].name, 'discovery');
  assert.equal(ordinaryObservations(receipt.checks[0]).length, 2);
  assert.equal(receipt.checks[0].passed, false);
  assert.equal(receipt.checks[0].code, 'FINAL_OBSERVATION_UNAVAILABLE');
  assert.ok(receipt.checks.slice(1).every(check => check.passed),
    'Per-fixture counters must leave later independent scenarios unaffected');
  assert.equal(receipt.passed, false);
  assert.ok(elapsed < 5000, 'Stuck observer must not cause unbounded wait');
  assert.equal(records.length, receipt.checkCount);
  assert.ok(records.every(record => record.closed),
    'Cleanup must close every fixture despite the unavailable final observation');
  assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
});

test('scheduler overshoot still leaves an observation at or after the full window', async () => {
  const records = [];
  const windowMs = 20;
  let overshoot;
  const createFixture = tracedInventoryFactory(records, {
    onSnapshot: ({ fixtureIndex, callNumber }) => {
      if (fixtureIndex === 0 && callNumber === 3) {
        const startedAt = performance.now();
        // Deliberately block this fixture's final-audit callback beyond the
        // window. This is bounded local scheduling pressure, not a timer race.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        overshoot = { startedAt, finishedAt: performance.now() };
      }
    },
  });
  const receipt = await runPreviewContract({ name: 'scheduler-overshoot',
    createFixture, observationWindowMs: windowMs, timeoutMs: 200 });
  assert.equal(receipt.passed, true, JSON.stringify(receipt.checks[0]));
  assert.ok(overshoot, 'The final-audit callback must encounter the scheduler stall');
  const record = records[0];
  const scenarioEnd = record.calls[ordinaryObservations(receipt.checks[0]).length - 1].completedAt;
  assert.ok(record.calls.at(-1).startedAt >= scenarioEnd + windowMs,
    'The last snapshot must start at or after the full configured window');
  if (overshoot.startedAt < scenarioEnd + windowMs) {
    assert.ok(record.calls.at(-1).startedAt >= overshoot.finishedAt,
      'A callback started before the deadline cannot replace the terminal observation after overshoot');
  }
  assert.ok(records.every(record => record.closed));
});

test('invalid observation window values are rejected before creating fixtures', async () => {
  let created = 0;
  const factory = async () => { created += 1; return createInventoryFixture(); };
  await assert.rejects(async () => runPreviewContract({ name: 'invalid-window-negative',
    createFixture: factory, observationWindowMs: -1 }));
  await assert.rejects(async () => runPreviewContract({ name: 'invalid-window-too-large',
    createFixture: factory, observationWindowMs: 3000 }));
  await assert.rejects(async () => runPreviewContract({ name: 'invalid-window-non-integer',
    createFixture: factory, observationWindowMs: 50.5 }));
  await assert.rejects(async () => runPreviewContract({ name: 'invalid-window-nan',
    createFixture: factory, observationWindowMs: NaN }));
  await assert.rejects(async () => runPreviewContract({ name: 'invalid-window-infinity',
    createFixture: factory, observationWindowMs: Infinity }));
  await assert.rejects(async () => runPreviewContract({ name: 'invalid-window-string',
    createFixture: factory, observationWindowMs: '50' }));
  await assert.rejects(async () => runPreviewContract({ name: 'invalid-window-null',
    createFixture: factory, observationWindowMs: null }));
  assert.equal(created, 0, 'No fixtures should be created for invalid parameters');
});

test('exact upper boundary window observes through the full 2000ms for every valid case',
  { timeout: 30000 }, async () => {
  const records = [];
  const windowMs = 2000;
  const receipt = await runPreviewContract({ name: 'inventory-max-window',
    createFixture: tracedInventoryFactory(records), observationWindowMs: windowMs });
  assert.equal(receipt.passed, true);
  assert.equal(records.length, receipt.checkCount);
  for (const [index, check] of receipt.checks.entries()) {
    const record = records[index];
    const ordinaryCount = ordinaryObservations(check).length;
    const scenarioEnd = record.calls[ordinaryCount - 1].completedAt;
    const terminalStart = record.calls.at(-1).startedAt;
    assert.ok(terminalStart >= scenarioEnd + windowMs,
      check.name + ': the terminal observation must start after all ' + windowMs + 'ms, not after a small fixed poll count');
    assert.equal(record.snapshotsBeforeClose, check.observations.length);
    assert.equal(record.closed, true);
  }
});
