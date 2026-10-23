import { createHash } from 'node:crypto';
import { McpError, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 10000;
const MAX_DEPTH = 32;
const PROTOCOL_REJECTIONS = new Set([-32700, -32600, -32601, -32602]);

/** Deterministic, bounded JSON. This is not an RFC 8785/JCS implementation. */
export function canonicalJson(value) {
  let nodes = 0;
  const active = new WeakSet();
  function visit(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError('JSON observation exceeds bounds');
    if (item === null) return 'null';
    if (typeof item === 'string') {
      if (item.length > MAX_BYTES) throw new TypeError('JSON string exceeds bounds');
      return JSON.stringify(item);
    }
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Only finite JSON numbers are supported');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Only explicit JSON values are supported');
    if (active.has(item)) throw new TypeError('Cyclic JSON observation');
    const prototype = Object.getPrototypeOf(item);
    const array = Array.isArray(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain JSON containers are supported');
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol state is not JSON');
    const keys = Object.keys(descriptors);
    if (keys.length > MAX_NODES) throw new TypeError('JSON container exceeds bounds');
    active.add(item);
    let output;
    try {
      if (array) {
        if (keys.length !== item.length + 1 || item.length > MAX_NODES) throw new TypeError('Sparse or extended arrays are not JSON observations');
        const parts = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Array accessors and holes are not supported');
          parts.push(visit(descriptor.value, depth + 1));
        }
        output = '[' + parts.join(',') + ']';
      } else {
        output = '{' + keys.sort().map(key => {
          const descriptor = descriptors[key];
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Hidden properties and accessors are not JSON observations');
          return JSON.stringify(key) + ':' + visit(descriptor.value, depth + 1);
        }).join(',') + '}';
      }
    } finally { active.delete(item); }
    if (Buffer.byteLength(output) > MAX_BYTES) throw new TypeError('JSON observation exceeds byte limit');
    return output;
  }
  const output = visit(value, 0);
  if (Buffer.byteLength(output) > MAX_BYTES) throw new TypeError('JSON observation exceeds byte limit');
  return output;
}

export function stateHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function timeoutValue(value = 2000) {
  if (!Number.isInteger(value) || value < 1 || value > 60000) throw new TypeError('timeoutMs must be an integer from 1 to 60000');
  return value;
}

async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Outcome unavailable')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** A timeout does not cancel an operation. This helper never retries it. */
export async function callOnce(call, { timeoutMs = 2000 } = {}) {
  if (typeof call !== 'function') throw new TypeError('call must be a function');
  timeoutValue(timeoutMs);
  try {
    const result = await bounded(call, timeoutMs);
    // Validate descriptors before reading fields; adapters should return JSON,
    // and malformed getters must not run during response classification.
    canonicalJson(result);
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== 'boolean')
      || (result.structuredContent !== undefined && (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)))) {
      return { kind: 'unknown', attempts: 1, code: 'MALFORMED_RESPONSE' };
    }
    if (!CallToolResultSchema.safeParse(result).success) return { kind: 'unknown', attempts: 1, code: 'MALFORMED_RESPONSE' };
    return { kind: result.isError === true ? 'tool-error' : 'result', result, attempts: 1 };
  } catch (error) {
    if (error instanceof McpError && PROTOCOL_REJECTIONS.has(error.code)) {
      return { kind: 'protocol-error', attempts: 1, code: String(error.code) };
    }
    return { kind: 'unknown', attempts: 1, code: 'OUTCOME_UNKNOWN' };
  }
}

class Violation extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireThat(condition, code) { if (!condition) throw new Violation(code); }
function same(a, b) { return canonicalJson(a) === canonicalJson(b); }
function clone(value) { return JSON.parse(canonicalJson(value)); }
function decodePreview(preview) {
  requireThat(preview && typeof preview.token === 'string' && preview.token.length > 0 && preview.token.length <= 4096 && Array.isArray(preview.plan), 'INVALID_PREVIEW');
  return { token: preview.token, plan: clone(preview.plan) };
}
function decodeResult(value) {
  canonicalJson(value);
  requireThat(value && typeof value === 'object', 'INVALID_DECODED_RESULT');
  if (value.kind === 'preview') return { kind: 'preview', preview: decodePreview(value.preview) };
  if (value.kind === 'committed') {
    requireThat(Array.isArray(value.plan), 'INVALID_COMMIT_RESULT');
    return { kind: 'committed', plan: clone(value.plan) };
  }
  if (value.kind === 'rejected') return { kind: 'rejected', ...(value.preview === undefined ? {} : { preview: decodePreview(value.preview) }) };
  throw new Violation('UNRECOGNIZED_RESULT');
}

const CASES = [
  'discovery', 'preview_read_only', 'missing_token', 'invalid_token', 'scope_binding',
  'commit_effects', 'stale_reconfirmation', 'duplicate_confirmation', 'repeat_preview', 'concurrent_confirmation',
];

/**
 * Execute only against caller-owned disposable fixtures. Adapters/observers are
 * trusted test code, not a sandbox or a production security boundary.
 */
export async function runPreviewContract({ name, createFixture, timeoutMs = 2000 }) {
  timeoutValue(timeoutMs);
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new TypeError('A short printable fixture name is required');
  if (typeof createFixture !== 'function') throw new TypeError('createFixture must be a function');
  const checks = [];
  for (const caseName of CASES) {
    const receipt = { name: caseName, passed: false, code: 'NOT_COMPLETED', calls: [], observations: [], cleanup: 'not-created' };
    let fixture, initial, last, creation, validated = false;
    try {
      creation = Promise.resolve().then(createFixture);
      fixture = await bounded(() => creation, timeoutMs);
      requireThat(fixture?.disposable === true, 'DISPOSABLE_FIXTURE_REQUIRED');
      requireThat(fixture.client && typeof fixture.client.callTool === 'function' && typeof fixture.client.listTools === 'function', 'CLIENT_REQUIRED');
      requireThat(typeof fixture.close === 'function' && typeof fixture.observer?.snapshot === 'function' && typeof fixture.observer?.change === 'function', 'INDEPENDENT_OBSERVER_REQUIRED');
      const profile = fixture.profile;
      requireThat(profile && typeof profile.toolName === 'string' && profile.toolName.length > 0
        && ['previewArguments','commitArguments','invalidToken','otherScopeArguments','decode'].every(key => typeof profile[key] === 'function'), 'PROFILE_REQUIRED');
      const expected = clone(fixture.expected);
      requireThat(['initial','plan','afterCommit','changed','changedPlan','afterReconfirm','commitWrites','reconfirmWrites'].every(key => Object.hasOwn(expected, key)), 'COMPLETE_ORACLE_REQUIRED');
      requireThat(Array.isArray(expected.plan) && expected.plan.length > 0 && Array.isArray(expected.changedPlan) && expected.changedPlan.length > 0
        && Number.isSafeInteger(expected.commitWrites) && expected.commitWrites > 0 && Number.isSafeInteger(expected.reconfirmWrites) && expected.reconfirmWrites > 0, 'POSITIVE_SCENARIO_REQUIRED');
      validated = true;
      async function observe(label) {
        const observation = await bounded(() => fixture.observer.snapshot(), timeoutMs);
        requireThat(observation && Object.hasOwn(observation, 'state') && Number.isSafeInteger(observation.writes) && observation.writes >= 0, 'INVALID_OBSERVATION');
        const clean = { state: clone(observation.state), writes: observation.writes };
        requireThat(!last || clean.writes >= last.writes, 'MUTATION_JOURNAL_MOVED_BACKWARD');
        last = clean;
        receipt.observations.push({ phase: label, stateSha256: stateHash(clean.state), writes: clean.writes });
        return clean;
      }
      async function invoke(phase, argumentsValue) {
        const args = clone(argumentsValue);
        requireThat(args && typeof args === 'object' && !Array.isArray(args), 'ARGUMENT_OBJECT_REQUIRED');
        const entry = { phase, outcome: 'pending', argumentsSha256: stateHash(args) };
        receipt.calls.push(entry);
        const outcome = await callOnce(() => fixture.client.callTool({ name: profile.toolName, arguments: args }), { timeoutMs });
        entry.outcome = outcome.kind;
        requireThat(outcome.kind === 'result' || outcome.kind === 'tool-error', outcome.kind === 'unknown' ? 'OUTCOME_UNKNOWN_STOPPED' : 'PROTOCOL_ERROR_NOT_SAFE_REJECTION');
        const decoded = decodeResult(profile.decode(outcome.result));
        requireThat(outcome.kind !== 'tool-error' || decoded.kind === 'rejected', 'TOOL_ERROR_CANNOT_BE_SUCCESS');
        return decoded;
      }
      function unchanged(before, after, prefix) {
        requireThat(same(before.state, after.state), prefix + '_MUTATED_STATE');
        requireThat(before.writes === after.writes, prefix + '_WROTE');
      }
      async function preview(expectedPlan = expected.plan) {
        const before = await observe('before-preview');
        const result = await invoke('preview', profile.previewArguments());
        const after = await observe('after-preview');
        unchanged(before, after, 'PREVIEW');
        requireThat(result.kind === 'preview' && same(result.preview.plan, expectedPlan), 'PREVIEW_ORACLE_MISMATCH');
        return result.preview;
      }
      async function approvedCommit(p, expectedState = expected.afterCommit, writes = expected.commitWrites) {
        const before = await observe('before-confirmation');
        const result = await invoke('confirmation', profile.commitArguments(p.token));
        const after = await observe('after-confirmation');
        requireThat(result.kind === 'committed' && same(result.plan, p.plan), 'COMMIT_PLAN_MISMATCH');
        requireThat(same(after.state, expectedState), 'COMMIT_EFFECT_MISMATCH');
        requireThat(after.writes - before.writes === writes, 'COMMIT_MUTATION_COUNT_MISMATCH');
      }
      initial = await observe('initial');
      receipt.beforeStateSha256 = stateHash(initial.state);
      requireThat(same(initial.state, expected.initial), 'INITIAL_ORACLE_MISMATCH');
      if (caseName === 'discovery') {
        let cursor, found = false;
        const seen = new Set();
        for (let page = 0; page < 32; page++) {
          const inventory = await bounded(() => fixture.client.listTools(cursor ? { cursor } : {}), timeoutMs);
          requireThat(inventory && Array.isArray(inventory.tools), 'INVALID_TOOL_INVENTORY');
          found ||= inventory.tools.some(tool => tool.name === profile.toolName);
          if (inventory.nextCursor === undefined) break;
          requireThat(typeof inventory.nextCursor === 'string' && inventory.nextCursor.length > 0 && !seen.has(inventory.nextCursor) && page < 31, 'INVALID_DISCOVERY_PAGINATION');
          cursor = inventory.nextCursor; seen.add(cursor);
        }
        requireThat(found, 'TOOL_NOT_ADVERTISED');
        unchanged(initial, await observe('after-discovery'), 'DISCOVERY');
      } else if (caseName === 'preview_read_only') {
        await preview();
      } else if (caseName === 'missing_token' || caseName === 'invalid_token') {
        let token;
        if (caseName === 'invalid_token') {
          const reviewed = await preview();
          token = profile.invalidToken(reviewed.token);
          requireThat(typeof token === 'string' && token.length > 0 && token.length <= 4096 && token !== reviewed.token, 'DISTINCT_INVALID_TOKEN_REQUIRED');
        }
        const result = await invoke(caseName, profile.commitArguments(token));
        requireThat(result.kind === 'rejected', 'UNREVIEWED_WRITE_NOT_REJECTED');
        unchanged(initial, await observe('after-unreviewed-request'), 'UNREVIEWED_REQUEST');
      } else if (caseName === 'scope_binding') {
        const p = await preview();
        const args = profile.otherScopeArguments(p.token);
        requireThat(!same(args, profile.commitArguments(p.token)), 'DISTINCT_SCOPE_REQUIRED');
        const result = await invoke('different-scope', args);
        requireThat(result.kind === 'rejected', 'SCOPE_CHANGE_NOT_REJECTED');
        unchanged(initial, await observe('after-scope-change'), 'SCOPE_CHANGE');
      } else if (caseName === 'commit_effects') {
        await approvedCommit(await preview());
      } else if (caseName === 'stale_reconfirmation') {
        const old = await preview();
        await bounded(() => fixture.observer.change(), timeoutMs);
        const changed = await observe('after-independent-change');
        requireThat(!same(changed.state, initial.state) && same(changed.state, expected.changed) && changed.writes > initial.writes, 'REAL_DECISION_CHANGE_REQUIRED');
        const result = await invoke('stale-confirmation', profile.commitArguments(old.token));
        const after = await observe('after-stale-rejection');
        requireThat(result.kind === 'rejected' && result.preview, 'FRESH_REVIEW_REQUIRED');
        unchanged(changed, after, 'STALE_REJECTION');
        requireThat(result.preview.token !== old.token && same(result.preview.plan, expected.changedPlan), 'FRESH_PREVIEW_ORACLE_MISMATCH');
        await approvedCommit(result.preview, expected.afterReconfirm, expected.reconfirmWrites);
      } else if (caseName === 'duplicate_confirmation') {
        const p = await preview(); await approvedCommit(p);
        const before = await observe('before-duplicate');
        const repeated = await invoke('duplicate-confirmation', profile.commitArguments(p.token));
        requireThat(repeated.kind === 'rejected' || repeated.kind === 'committed', 'INVALID_DUPLICATE_RESPONSE');
        requireThat(repeated.kind !== 'committed' || same(repeated.plan, p.plan) || repeated.plan.length === 0, 'INVALID_DUPLICATE_PLAN');
        unchanged(before, await observe('after-duplicate'), 'DUPLICATE');
      } else if (caseName === 'repeat_preview') {
        const p = await preview(); await approvedCommit(p); await preview([]);
      } else if (caseName === 'concurrent_confirmation') {
        const p = await preview();
        const before = await observe('before-concurrent-confirmations');
        const settled = await Promise.allSettled([
          invoke('concurrent-confirmation-1', profile.commitArguments(p.token)),
          invoke('concurrent-confirmation-2', profile.commitArguments(p.token)),
        ]);
        const after = await observe('after-concurrent-confirmations');
        const rejected = settled.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
        const results = settled.map(result => result.value);
        requireThat(results.some(result => result.kind === 'committed' && same(result.plan, p.plan))
          && results.every(result => result.kind === 'rejected' || (result.kind === 'committed' && (same(result.plan, p.plan) || result.plan.length === 0))), 'INVALID_CONCURRENT_RESPONSES');
        requireThat(same(after.state, expected.afterCommit) && after.writes - before.writes === expected.commitWrites, 'CONCURRENT_EFFECT_MISMATCH');
      }
      receipt.passed = true; receipt.code = 'PASS';
    } catch (error) {
      receipt.code = error instanceof Violation ? error.code : 'PROFILE_OR_OBSERVER_ERROR';
    } finally {
      // Capture a last independent observation even if decoding failed after a
      // write. This never turns an unknown outcome into a safe rejection.
      if (validated && typeof fixture.observer.snapshot === 'function') {
        try {
          const observed = await bounded(() => fixture.observer.snapshot(), timeoutMs);
          if (observed && Number.isSafeInteger(observed.writes) && observed.writes >= 0 && Object.hasOwn(observed, 'state')) {
            const clean = { state: clone(observed.state), writes: observed.writes };
            if (last && clean.writes < last.writes) { receipt.passed = false; receipt.code = 'MUTATION_JOURNAL_MOVED_BACKWARD'; }
            else if (last && (clean.writes !== last.writes || !same(clean.state, last.state))) {
              receipt.finalObservationChanged = true;
              if (receipt.passed) { receipt.passed = false; receipt.code = 'UNREQUESTED_CHANGE_BEFORE_CLEANUP'; }
            }
            last = clean;
            receipt.observations.push({ phase: 'last-observed-before-cleanup', stateSha256: stateHash(clean.state), writes: clean.writes });
          } else { receipt.passed = false; receipt.code = 'INVALID_FINAL_OBSERVATION'; }
        } catch { receipt.passed = false; receipt.code = 'FINAL_OBSERVATION_UNAVAILABLE'; }
      }
      if (last) {
        receipt.afterStateSha256 = stateHash(last.state);
        receipt.mutationDelta = last.writes - (initial?.writes ?? last.writes);
      }
      if (fixture && typeof fixture.close === 'function') {
        try { await bounded(() => fixture.close(), timeoutMs); receipt.cleanup = 'closed'; }
        catch { receipt.cleanup = 'failed'; receipt.passed = false; receipt.code = 'CLEANUP_FAILED'; }
      } else if (!fixture && creation) {
        // A factory timeout does not prove it never created a client. Close a
        // late returned fixture, while retaining uncertainty in this receipt.
        receipt.cleanup = 'pending-factory';
        creation.then(late => {
          if (late && typeof late.close === 'function') return bounded(() => late.close(), timeoutMs);
        }).catch(() => {});
      }
    }
    checks.push(receipt);
  }
  return { profile: 'preview-confirm-v1', name, passed: checks.every(check => check.passed),
    checkCount: checks.length, passedCount: checks.filter(check => check.passed).length, checks,
    scope: 'Observed disposable-fixture application contract; not MCP certification, human approval or production security validation' };
}
