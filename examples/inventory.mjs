import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectFixture, pause, preview, response, structured } from './support.mjs';

// These expected states are fixture-owned literals, never server result data.
const INITIAL = { available: { bolts: 6, washers: 12, tape: 4 }, kit: [] };
const PLAN = [{ sku: 'bolts', quantity: 1 }, { sku: 'washers', quantity: 1 }];
const COMPLETE = {
  available: { bolts: 5, washers: 11, tape: 4 },
  kit: [{ sku: 'bolts', quantity: 1 }, { sku: 'washers', quantity: 1 }],
};
const CHANGED = {
  available: { bolts: 5, washers: 12, tape: 4 },
  kit: [{ sku: 'bolts', quantity: 1 }],
};

/**
 * Disposable assembly-kit reservation example. Faults exist only for sensitivity
 * tests; they are never selectable through the CLI or exposed as a service.
 */
export async function createInventoryFixture({ fault = null } = {}) {
  let store = structuredClone(INITIAL);
  let writes = 0;
  const nonce = randomUUID();
  const issued = new Map();
  const mutate = operation => { operation(store); writes += 1; };
  const changesFor = skus => skus.filter(sku => !store.kit.some(line => line.sku === sku))
    .map(sku => ({ sku, quantity: 1 }));
  const permitFor = skus => 'kit-permit/' + createHash('sha256')
    .update(JSON.stringify({ nonce, skus, store })).digest('base64url');
  const inspect = skus => {
    const permit = permitFor(skus);
    const changes = changesFor(skus);
    issued.set(permit, { changes: structuredClone(changes), state: JSON.stringify(store), skus: [...skus] });
    return { permit, changes };
  };
  const reserve = changes => mutate(current => {
    for (const item of changes) {
      current.available[item.sku] -= item.quantity;
      current.kit.push(structuredClone(item));
    }
  });
  const connection = await connectFixture('kit-reservation-example', server => {
    server.registerTool('reserve_kit', {
      description: 'Reserve synthetic assembly parts after a state-bound preview. No real inventory is connected.',
      inputSchema: {
        skus: z.array(z.enum(['bolts', 'washers', 'tape'])).min(1).max(3),
        dry_run: z.boolean(), expected_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ skus, dry_run, expected_token }) => {
      const fresh = inspect(skus);
      if (dry_run) {
        if (fault === 'preview-mutation') mutate(current => { current.available.bolts -= 1; });
        if (fault === 'preview-rollback') {
          mutate(current => { current.available.bolts -= 1; });
          mutate(current => { current.available.bolts += 1; });
        }
        if (fault === 'wrong-preview') return response({ phase: 'preview', ...fresh, changes: [] });
        return response({ phase: 'preview', ...fresh });
      }
      const prior = issued.get(expected_token);
      const sameScope = prior && JSON.stringify(prior.skus) === JSON.stringify(skus);
      const current = expected_token === fresh.permit;
      const acceptStale = fault === 'stale-acceptance' && sameScope;
      const acceptOtherScope = fault === 'scope-ignored' && prior && prior.state === JSON.stringify(store);
      const replay = fault === 'duplicate-replay' && sameScope && fresh.changes.length === 0;
      const valid = current || fault === 'ignore-token' || acceptStale || acceptOtherScope || replay;
      if (!valid) {
        if (fault === 'error-after-mutation') reserve(fresh.changes);
        return response({ phase: 'blocked', fresh }, true);
      }
      let applied = replay ? prior.changes : fresh.changes;
      if (fault === 'concurrent-double-write') await pause();
      if (fault === 'partial-effect') applied = applied.slice(0, 1);
      if (applied.length) reserve(applied);
      if (fault === 'extra-effect') reserve([{ sku: 'tape', quantity: 1 }]);
      // An intentionally faulty server can lie about its effects. The observer,
      // not this response, is what lets the harness expose that lie.
      return response({ phase: 'applied', reserved: fresh.changes });
    });
  });
  const requested = ['bolts', 'washers'];
  return {
    disposable: true,
    client: connection.client,
    profile: {
      toolName: 'reserve_kit',
      previewArguments: () => ({ skus: [...requested], dry_run: true }),
      commitArguments: token => ({ skus: [...requested], dry_run: false, ...(token === undefined ? {} : { expected_token: token }) }),
      invalidToken: reviewedToken => reviewedToken + '-unissued',
      otherScopeArguments: token => ({ skus: ['tape'], dry_run: false, expected_token: token }),
      decode: result => {
        const data = structured(result);
        if (data.phase === 'preview') return { kind: 'preview', preview: preview(data.permit, data.changes) };
        if (data.phase === 'applied' && Array.isArray(data.reserved)) return { kind: 'committed', plan: data.reserved };
        if (data.phase === 'blocked') return { kind: 'rejected', ...(data.fresh ? { preview: preview(data.fresh.permit, data.fresh.changes) } : {}) };
        throw new TypeError('Unrecognized inventory response');
      },
    },
    observer: {
      snapshot: async () => ({ state: structuredClone(store), writes }),
      change: async () => reserve([{ sku: 'bolts', quantity: 1 }]),
    },
    expected: structuredClone({ initial: INITIAL, plan: PLAN, afterCommit: COMPLETE,
      changed: CHANGED, changedPlan: [{ sku: 'washers', quantity: 1 }], afterReconfirm: COMPLETE,
      commitWrites: 1, reconfirmWrites: 1 }),
    close: connection.close,
  };
}
