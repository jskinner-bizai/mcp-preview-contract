import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { canonicalJson, stateHash, callOnce, runPreviewContract } from '../src/index.mjs';

// These are focused unit doubles. Separate integration tests use real SDK
// Client/McpServer pairs and independently observed disposable stores.
const ok = () => ({
  content: [{ type: 'text', text: 'Synthetic unit result' }],
  structuredContent: { accepted: true },
});

test('canonical JSON sorts nested object keys while preserving array order', () => {
  const a = { z: [3, { b: 2, a: 1 }], a: { z: null, a: true } };
  const b = { a: { a: true, z: null }, z: [3, { a: 1, b: 2 }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"a":true,"z":null},"z":[3,{"a":1,"b":2}]}');
  assert.notEqual(stateHash([1, 2]), stateHash([2, 1]));
});

test('state hashing is deterministic, bounded SHA256 and sensitive to actual state', () => {
  const first = { selected: ['a', 'b'], count: 2 };
  const equal = { count: 2, selected: ['a', 'b'] };
  const changed = { count: 3, selected: ['a', 'b'] };
  assert.match(stateHash(first), /^[a-f0-9]{64}$/);
  assert.equal(stateHash(first), stateHash(equal));
  assert.notEqual(stateHash(first), stateHash(changed));
  assert.notEqual(stateHash({ value: '1' }), stateHash({ value: 1 }));
});

test('canonical JSON supports primitive JSON values without coercing them', () => {
  for (const [input, expected] of [[null, 'null'], [true, 'true'], [false, 'false'],
    [0, '0'], [-0, '0'], ['hello\nworld', '"hello\\nworld"']]) {
    assert.equal(canonicalJson(input), expected);
  }
});

test('shared noncyclic references remain valid JSON data', () => {
  const shared = { value: 7 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"value":7},"b":{"value":7}}');
});

test('own __proto__ data is preserved and cannot alter serialization prototypes', () => {
  const data = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
  assert.equal(canonicalJson(data), '{"__proto__":{"polluted":true},"x":1}');
  assert.equal({}.polluted, undefined);
  assert.notEqual(stateHash(data), stateHash({ x: 1 }));
});

test('plain null-prototype maps have the same JSON identity as ordinary maps', () => {
  const map = Object.create(null);
  map.z = 2;
  map.a = 1;
  assert.equal(canonicalJson(map), canonicalJson({ a: 1, z: 2 }));
});

for (const [label, value] of [
  ['top-level undefined', undefined],
  ['nested undefined', { item: undefined }],
  ['undefined array entry', [undefined]],
  ['function', () => 1],
  ['nested function', { run() {} }],
  ['symbol', Symbol('not-json')],
  ['bigint', 1n],
  ['NaN', NaN],
  ['infinity', Infinity],
  ['negative infinity', -Infinity],
  ['nested nonfinite number', { amount: NaN }],
  ['Date prototype', new Date('2026-10-23T00:00:00Z')],
  ['Map prototype', new Map([['a', 1]])],
  ['Set prototype', new Set([1])],
  ['boxed string', new String('a')],
  ['custom prototype', Object.assign(Object.create({ inherited: true }), { a: 1 })],
  ['sparse array', new Array(2)],
  ['array hole', [1, , 3]],
]) {
  test(`canonical JSON rejects ${label} rather than silently changing state`, () => {
    assert.throws(() => canonicalJson(value));
    assert.throws(() => stateHash(value));
  });
}

test('canonical JSON rejects object and array cycles', () => {
  const object = {};
  object.self = object;
  const array = [];
  array.push(array);
  assert.throws(() => canonicalJson(object));
  assert.throws(() => canonicalJson(array));
});

test('state observation never invokes getters', () => {
  let reads = 0;
  const object = {};
  Object.defineProperty(object, 'value', { enumerable: true, get() { reads += 1; return 1; } });
  assert.throws(() => canonicalJson(object));
  assert.equal(reads, 0);
});

test('state observation never invokes toJSON', () => {
  let calls = 0;
  const object = { value: 1, toJSON() { calls += 1; return {}; } };
  assert.throws(() => canonicalJson(object));
  assert.equal(calls, 0);
});

test('symbol and nonenumerable own state cannot disappear from a state hash', () => {
  const symbolState = { visible: true, [Symbol('hidden')]: 'important' };
  const nonenumerableState = { visible: true };
  Object.defineProperty(nonenumerableState, 'hidden', { value: 'important' });
  assert.throws(() => canonicalJson(symbolState));
  assert.throws(() => canonicalJson(nonenumerableState));
});

test('extra own array properties cannot disappear from a state hash', () => {
  const array = [1, 2];
  array.extra = 'important';
  assert.throws(() => canonicalJson(array));
});

test('deep and oversized observations fail within the documented bounded scope', () => {
  let deep = null;
  for (let i = 0; i < 40; i += 1) deep = { child: deep };
  assert.throws(() => canonicalJson(deep));
  assert.throws(() => canonicalJson(new Array(10001).fill(0)));
  assert.throws(() => canonicalJson('x'.repeat(1024 * 1024 + 1)));
});

test('callOnce returns one valid result without repeating the call', async () => {
  let attempts = 0;
  const response = ok();
  const outcome = await callOnce(async () => { attempts += 1; return response; });
  assert.equal(outcome.kind, 'result');
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(outcome.result, response);
  assert.equal(attempts, 1);
});

test('empty MCP content is a received result, leaving application validation to the profile', async () => {
  const response = { content: [], structuredContent: {}, isError: false };
  const outcome = await callOnce(async () => response);
  assert.equal(outcome.kind, 'result');
  assert.deepEqual(outcome.result, response);
  assert.equal(outcome.attempts, 1);
});

test('a tool error remains a tool error rather than proof of safe rejection', async () => {
  let attempts = 0;
  const response = { isError: true, content: [{ type: 'text', text: 'Synthetic rejection' }] };
  const outcome = await callOnce(async () => { attempts += 1; return response; });
  assert.equal(outcome.kind, 'tool-error');
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(outcome.result, response);
  assert.equal(attempts, 1);
  assert.equal(Object.hasOwn(outcome, 'writeApplied'), false);
});

test('a tool error after actual mutation does not become a safe-rejection assertion', async () => {
  let attempts = 0;
  let writes = 0;
  const outcome = await callOnce(async () => {
    attempts += 1;
    writes += 1;
    return { content: [{ type: 'text', text: 'Synthetic error after write' }], isError: true };
  });
  assert.equal(outcome.kind, 'tool-error');
  assert.equal(attempts, 1);
  assert.equal(writes, 1);
  assert.equal(Object.hasOwn(outcome, 'safeRejected'), false);
  assert.equal(Object.hasOwn(outcome, 'writeApplied'), false);
});

for (const code of [-32700, -32600, -32601, -32602]) {
  test(`actual SDK protocol error ${code} is classified once without retry`, async () => {
    let attempts = 0;
    const outcome = await callOnce(async () => {
      attempts += 1;
      throw new McpError(code, 'Synthetic protocol rejection');
    });
    assert.equal(outcome.kind, 'protocol-error');
    assert.equal(outcome.attempts, 1);
    assert.equal(typeof outcome.code, 'string');
    assert.equal(attempts, 1);
  });
}

for (const code of [-32603, -32000, -32001]) {
  test(`SDK internal or connection outcome ${code} stays unknown`, async () => {
    let attempts = 0;
    const outcome = await callOnce(async () => {
      attempts += 1;
      throw new McpError(code, 'Synthetic uncertain outcome');
    });
    assert.equal(outcome.kind, 'unknown');
    assert.equal(outcome.attempts, 1);
    assert.equal(attempts, 1);
  });
}

test('an Error impersonating McpError is not accepted as a known protocol rejection', async () => {
  const counterfeit = Object.assign(new Error('Synthetic transport error'), { name: 'McpError', code: -32602 });
  const outcome = await callOnce(async () => { throw counterfeit; });
  assert.equal(outcome.kind, 'unknown');
  assert.equal(outcome.attempts, 1);
});

test('a generic thrown transport error stays unknown and is not retried', async () => {
  let attempts = 0;
  const outcome = await callOnce(async () => { attempts += 1; throw new Error('unit-test-secret-do-not-log'); });
  assert.equal(outcome.kind, 'unknown');
  assert.equal(outcome.attempts, 1);
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(outcome).includes('unit-test-secret-do-not-log'), false);
});

test('a synchronous call exception stays unknown and is not retried', async () => {
  let attempts = 0;
  const outcome = await callOnce(() => { attempts += 1; throw new Error('Synthetic immediate failure'); });
  assert.equal(outcome.kind, 'unknown');
  assert.equal(outcome.attempts, 1);
  assert.equal(attempts, 1);
});

test('lost response after an actual write stays unknown with exactly one write', async () => {
  let attempts = 0;
  let writes = 0;
  const outcome = await callOnce(async () => {
    attempts += 1;
    writes += 1;
    throw new Error('Synthetic response lost after commit');
  });
  assert.equal(outcome.kind, 'unknown');
  assert.equal(outcome.attempts, 1);
  await delay(20);
  assert.equal(attempts, 1);
  assert.equal(writes, 1);
  assert.equal(Object.hasOwn(outcome, 'writeApplied'), false);
});

test('timeout returns unknown promptly without retrying an unresolved operation', async () => {
  let attempts = 0;
  const started = performance.now();
  const outcome = await callOnce(() => {
    attempts += 1;
    return new Promise(() => {});
  }, { timeoutMs: 15 });
  assert.equal(outcome.kind, 'unknown');
  assert.equal(outcome.attempts, 1);
  assert.ok(performance.now() - started < 2000);
  await delay(20);
  assert.equal(attempts, 1);
});

test('timeout does not claim cancellation when an operation finishes later', async () => {
  let attempts = 0;
  let writes = 0;
  const outcome = await callOnce(async () => {
    attempts += 1;
    await delay(35);
    writes += 1;
    return ok();
  }, { timeoutMs: 5 });
  assert.equal(outcome.kind, 'unknown');
  await delay(70);
  assert.equal(attempts, 1);
  assert.equal(writes, 1);
});

for (const [label, response] of [
  ['null', null], ['undefined', undefined], ['array', []], ['primitive', 'ok'],
  ['empty object', {}], ['non-array content', { content: 'ok' }],
  ['nonboolean isError', { content: [], isError: 'true' }],
  ['malformed text block', { content: [{ type: 'text', text: 42 }] }],
  ['array structured content', { content: [], structuredContent: [] }],
]) {
  test(`malformed result (${label}) fails closed as unknown with one attempt`, async () => {
    let attempts = 0;
    const outcome = await callOnce(async () => { attempts += 1; return response; });
    assert.equal(outcome.kind, 'unknown');
    assert.equal(outcome.attempts, 1);
    assert.equal(attempts, 1);
  });
}

for (const timeoutMs of [0, -1, NaN, Infinity, '10', null]) {
  test(`invalid timeout ${String(timeoutMs)} fails before invoking the operation`, async () => {
    let attempts = 0;
    await assert.rejects(async () => callOnce(async () => { attempts += 1; return ok(); }, { timeoutMs }));
    assert.equal(attempts, 0);
  });
}

// This small unit double exercises runner boundaries only. It is not evidence
// of MCP interoperability; the separate integration suite uses real SDK pairs.
function unitFactory(options = {}, totals = {}) {
  return async () => {
    totals.created = (totals.created ?? 0) + 1;
    let items = [];
    let writes = 0;
    let revision = 0;
    let snapshots = 0;
    const token = scope => options.hexTokens ? stateHash({ revision, scope }) : `unit-secret-token-${revision}:${scope}`;
    const proposed = scope => items.includes(scope) ? [] : [{ id: scope }];
    const decodedPreview = scope => ({ token: token(scope), plan: proposed(scope) });
    const response = (decoded, isError = false) => ({
      content: [{ type: 'text', text: 'Synthetic unit response' }],
      structuredContent: decoded,
      ...(isError ? { isError: true } : {}),
    });
    const fixture = {
      disposable: true,
      client: {
        async listTools() { return { tools: [{ name: 'unit_batch' }] }; },
        async callTool({ arguments: args }) {
          totals.toolCalls = (totals.toolCalls ?? 0) + 1;
          if (options.protocolError) throw new McpError(-32602, 'unit-secret-protocol-message');
          if (options.callTimeout) return new Promise(() => {});
          if (options.hexTokens && args.token !== undefined && !/^[a-f0-9]{64}$/.test(args.token)) {
            totals.schemaRejects = (totals.schemaRejects ?? 0) + 1;
            throw new McpError(-32602, 'Synthetic schema requires a 64-character hexadecimal token');
          }
          if (args.mode === 'preview') {
            if (options.previewRollback) {
              items.push('temporary'); writes += 1;
              items.pop(); writes += 1;
            }
            return response({ kind: 'preview', preview: decodedPreview(args.scope) });
          }
          if (args.scope !== 'a' || args.token !== token(args.scope)) {
            return response({ kind: 'rejected', preview: decodedPreview('a') }, true);
          }
          const plan = proposed(args.scope);
          if (plan.length) { items.push(args.scope); items.sort(); writes += 1; revision += 1; }
          return response({ kind: 'committed', plan });
        },
      },
      profile: {
        toolName: 'unit_batch',
        previewArguments: () => ({ mode: 'preview', scope: 'a' }),
        commitArguments: value => ({ mode: 'commit', scope: 'a', ...(value === undefined ? {} : { token: value }) }),
        invalidToken: reviewed => {
          const invalid = options.reviewedAsInvalid ? reviewed : options.hexTokens
            ? `${reviewed[0] === '0' ? '1' : '0'}${reviewed.slice(1)}` : `${reviewed}:unissued`;
          (totals.invalidTokenPairs ??= []).push({ reviewed, invalid });
          return invalid;
        },
        otherScopeArguments: value => ({ mode: 'commit', scope: 'c', token: value }),
        decode: result => {
          if (options.decodeError) throw new Error('unit-secret-decode-message');
          return result.structuredContent;
        },
      },
      observer: {
        async snapshot() {
          snapshots += 1;
          totals.snapshotCalls = (totals.snapshotCalls ?? 0) + 1;
          if (options.observerError) throw new Error('unit-secret-observer-message');
          // For preview_read_only, the fourth read is the final audit. Expose
          // a late backing-store mutation only there, after the normal check.
          if (options.lateFinalMutation && snapshots === 4) {
            items.push('late-unrequested'); items.sort(); writes += 1; revision += 1;
          }
          return {
            state: { items: [...items] },
            writes: options.backwardJournal ? (snapshots === 1 ? 3 : 2) : writes,
          };
        },
        async change() { items.push('b'); items.sort(); writes += 1; revision += 1; },
      },
      expected: {
        initial: { items: [] }, plan: [{ id: 'a' }], afterCommit: { items: ['a'] },
        changed: { items: ['b'] }, changedPlan: [{ id: 'a' }],
        afterReconfirm: { items: ['a', 'b'] }, commitWrites: 1, reconfirmWrites: 1,
      },
      async close() {
        totals.closed = (totals.closed ?? 0) + 1;
        if (options.cleanupError) throw new Error('unit-secret-cleanup-message');
      },
    };
    if (options.notDisposable) fixture.disposable = false;
    if (options.incompleteOracle) delete fixture.expected.afterCommit;
    if (options.cyclicOracle) fixture.expected.initial.self = fixture.expected.initial;
    return fixture;
  };
}

test('runner unit fixture validates the baseline and creates/closes one fresh fixture per case', async () => {
  const totals = {};
  const receipt = await runPreviewContract({ name: 'unit baseline', createFixture: unitFactory({}, totals) });
  assert.equal(receipt.passed, true);
  assert.equal(receipt.passedCount, receipt.checkCount);
  assert.equal(totals.created, receipt.checkCount);
  assert.equal(totals.closed, receipt.checkCount);
  assert.ok(receipt.checks.every(check => check.cleanup === 'closed'));
});

test('invalid-token checks support schema-restricted hexadecimal tokens through the profile hook', async () => {
  const totals = {};
  const receipt = await runPreviewContract({ name: 'unit hexadecimal tokens', createFixture: unitFactory({ hexTokens: true }, totals) });
  assert.equal(receipt.passed, true);
  assert.equal(totals.schemaRejects ?? 0, 0);
  assert.ok(totals.invalidTokenPairs.length > 0);
  for (const pair of totals.invalidTokenPairs) {
    assert.match(pair.reviewed, /^[a-f0-9]{64}$/);
    assert.match(pair.invalid, /^[a-f0-9]{64}$/);
    assert.notEqual(pair.reviewed, pair.invalid);
  }
  const invalid = receipt.checks.find(check => check.name === 'invalid_token');
  assert.equal(invalid.passed, true);
  assert.equal(invalid.calls.at(-1).outcome, 'tool-error');
  assert.equal(invalid.mutationDelta, 0);
});

test('an invalid-token hook cannot reuse the reviewed valid token to manufacture a check', async () => {
  const receipt = await runPreviewContract({ name: 'unit reused token hook', createFixture: unitFactory({ reviewedAsInvalid: true }) });
  const invalid = receipt.checks.find(check => check.name === 'invalid_token');
  assert.equal(receipt.passed, false);
  assert.equal(invalid.passed, false);
  assert.equal(invalid.code, 'DISTINCT_INVALID_TOKEN_REQUIRED');
  assert.equal(invalid.calls.length, 1);
  assert.equal(invalid.calls[0].phase, 'preview');
  assert.equal(invalid.mutationDelta, 0);
  assert.equal(invalid.beforeStateSha256, invalid.afterStateSha256);
});

test('missing disposable declaration prevents tool and observer calls but closes created fixtures', async () => {
  const totals = {};
  const receipt = await runPreviewContract({ name: 'unit no disposable guard', createFixture: unitFactory({ notDisposable: true }, totals) });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.passedCount, 0);
  assert.equal(totals.toolCalls ?? 0, 0);
  assert.equal(totals.snapshotCalls ?? 0, 0);
  assert.equal(totals.closed, receipt.checkCount);
});

for (const [name, options] of [['incomplete', { incompleteOracle: true }], ['cyclic', { cyclicOracle: true }]]) {
  test(`${name} independent oracle fails before invoking tools or observers`, async () => {
    const totals = {};
    const receipt = await runPreviewContract({ name: `unit ${name} oracle`, createFixture: unitFactory(options, totals) });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.passedCount, 0);
    assert.equal(totals.toolCalls ?? 0, 0);
    assert.equal(totals.snapshotCalls ?? 0, 0);
    assert.equal(totals.closed, receipt.checkCount);
  });
}

test('a backwards mutation journal cannot yield a passed check', async () => {
  const receipt = await runPreviewContract({ name: 'unit backwards journal', createFixture: unitFactory({ backwardJournal: true }) });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.passedCount, 0);
  assert.ok(receipt.checks.every(check => check.code === 'MUTATION_JOURNAL_MOVED_BACKWARD'));
});

test('cleanup failure prevents success even after correct observable behavior', async () => {
  const receipt = await runPreviewContract({ name: 'unit cleanup failure', createFixture: unitFactory({ cleanupError: true }) });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.passedCount, 0);
  assert.ok(receipt.checks.every(check => check.cleanup === 'failed' && check.code === 'CLEANUP_FAILED'));
  assert.equal(JSON.stringify(receipt).includes('unit-secret-cleanup-message'), false);
});

test('factory timeout is bounded and starts each planned case once without tool calls', async () => {
  let created = 0;
  const receipt = await runPreviewContract({
    name: 'unit factory timeout', timeoutMs: 5,
    createFixture: () => { created += 1; return new Promise(() => {}); },
  });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.passedCount, 0);
  assert.equal(created, receipt.checkCount);
  assert.ok(receipt.checks.every(check => check.calls.length === 0 && check.cleanup === 'pending-factory'));
});

test('late returned fixtures are closed after factory timeout without claiming cancellation', async () => {
  const totals = {};
  const create = unitFactory({}, totals);
  const receipt = await runPreviewContract({
    name: 'unit late factory cleanup', timeoutMs: 5,
    createFixture: async () => { const fixture = await create(); await delay(30); return fixture; },
  });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.checks.every(check => check.cleanup === 'pending-factory'));
  await delay(70);
  assert.equal(totals.created, receipt.checkCount);
  assert.equal(totals.closed, receipt.checkCount);
  assert.equal(totals.toolCalls ?? 0, 0);
  assert.equal(totals.snapshotCalls ?? 0, 0);
});

test('call timeout stops each case at its first attempted tool request', async () => {
  const totals = {};
  const receipt = await runPreviewContract({ name: 'unit call timeout', timeoutMs: 5, createFixture: unitFactory({ callTimeout: true }, totals) });
  assert.equal(receipt.passed, false);
  const invoked = receipt.checks.filter(check => check.calls.length);
  assert.ok(invoked.length > 0);
  assert.ok(invoked.every(check => !check.passed && check.calls.length === 1 && check.calls[0].outcome === 'unknown'));
  assert.equal(totals.toolCalls, invoked.length);
  assert.equal(totals.closed, receipt.checkCount);
});

test('protocol exceptions are not safe missing-token rejection despite unchanged state', async () => {
  const receipt = await runPreviewContract({ name: 'unit protocol exception', createFixture: unitFactory({ protocolError: true }) });
  const missing = receipt.checks.find(check => check.name === 'missing_token');
  assert.equal(receipt.passed, false);
  assert.equal(missing.passed, false);
  assert.equal(missing.calls.length, 1);
  assert.equal(missing.calls[0].outcome, 'protocol-error');
  assert.equal(missing.beforeStateSha256, missing.afterStateSha256);
  assert.equal(missing.mutationDelta, 0);
  assert.equal(JSON.stringify(receipt).includes('unit-secret-protocol-message'), false);
});

test('preview write and rollback is detected by the independent mutation journal', async () => {
  const receipt = await runPreviewContract({ name: 'unit preview rollback', createFixture: unitFactory({ previewRollback: true }) });
  const preview = receipt.checks.find(check => check.name === 'preview_read_only');
  assert.equal(receipt.passed, false);
  assert.equal(preview.passed, false);
  assert.equal(preview.beforeStateSha256, preview.afterStateSha256);
  assert.equal(preview.mutationDelta, 2);
  assert.equal(preview.code, 'PREVIEW_WROTE');
});

test('a late unrequested mutation exposed by the final preview audit cannot remain PASS', async () => {
  const receipt = await runPreviewContract({ name: 'unit late preview mutation', createFixture: unitFactory({ lateFinalMutation: true }) });
  const preview = receipt.checks.find(check => check.name === 'preview_read_only');
  assert.equal(receipt.passed, false);
  assert.equal(preview.passed, false);
  assert.equal(preview.code, 'UNREQUESTED_CHANGE_BEFORE_CLEANUP');
  assert.equal(preview.finalObservationChanged, true);
  assert.equal(preview.mutationDelta, 1);
  assert.notEqual(preview.beforeStateSha256, preview.afterStateSha256);
  assert.equal(preview.cleanup, 'closed');
  const audit = preview.observations.at(-1);
  assert.equal(audit.phase, 'last-observed-before-cleanup');
  assert.equal(audit.writes, 1);
  assert.equal(audit.stateSha256, preview.afterStateSha256);
});

test('receipts contain hashes and classifications, never raw tokens or adapter exception text', async () => {
  const normal = await runPreviewContract({ name: 'unit sanitized receipt', createFixture: unitFactory() });
  assert.equal(normal.passed, true);
  assert.equal(JSON.stringify(normal).includes('unit-secret-token'), false);
  assert.ok(normal.checks.flatMap(check => check.calls).every(call => /^[a-f0-9]{64}$/.test(call.argumentsSha256)));
  for (const fault of [{ decodeError: true }, { observerError: true }]) {
    const receipt = await runPreviewContract({ name: 'unit sanitized failure', createFixture: unitFactory(fault) });
    assert.equal(receipt.passed, false);
    assert.equal(JSON.stringify(receipt).includes('unit-secret-'), false);
  }
});
