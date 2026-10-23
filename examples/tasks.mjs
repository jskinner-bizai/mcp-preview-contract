import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectFixture, pause, preview, response, structured } from './support.mjs';

const INITIAL = { tasks: [{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }, { id: 'c', status: 'open' }] };
const PLAN = [{ taskId: 'a', status: 'done' }, { taskId: 'b', status: 'done' }];
const COMPLETE = { tasks: [{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }, { id: 'c', status: 'open' }] };
const CHANGED = { tasks: [{ id: 'a', status: 'done' }, { id: 'b', status: 'open' }, { id: 'c', status: 'open' }] };

/** Independent task-domain adapter: different arguments, result envelope and effects. */
export async function createTaskFixture({ fault = null } = {}) {
  let board = structuredClone(INITIAL);
  let writes = 0;
  const nonce = randomUUID();
  const issued = new Map();
  const mutate = operation => { operation(board); writes += 1; };
  const actionsFor = ids => board.tasks.filter(task => ids.includes(task.id) && task.status !== 'done')
    .map(task => ({ taskId: task.id, status: 'done' }));
  const ticketFor = ids => 'task-ticket:' + createHash('sha256')
    .update(JSON.stringify({ nonce, ids, board })).digest('base64url');
  const inspect = ids => {
    const ticket = ticketFor(ids), actions = actionsFor(ids);
    issued.set(ticket, { actions: structuredClone(actions), state: JSON.stringify(board), ids: [...ids] });
    return { ticket, actions };
  };
  const complete = actions => mutate(current => {
    for (const action of actions) current.tasks.find(task => task.id === action.taskId).status = action.status;
  });
  const connection = await connectFixture('task-completion-example', server => {
    server.registerTool('complete_tasks', {
      description: 'Complete synthetic task IDs only after inspecting their revision-bound proposal. No external task service.',
      inputSchema: { ids: z.array(z.enum(['a', 'b', 'c'])).min(1).max(3),
        mode: z.enum(['inspect', 'apply']), ticket: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }, async ({ ids, mode, ticket }) => {
      const current = inspect(ids);
      if (mode === 'inspect') {
        if (fault === 'preview-mutation') mutate(value => { value.tasks[2].status = 'done'; });
        if (fault === 'preview-rollback') {
          mutate(value => { value.tasks[2].status = 'done'; });
          mutate(value => { value.tasks[2].status = 'open'; });
        }
        if (fault === 'wrong-preview') return response({ state: 'inspection', ...current, actions: [] });
        return response({ state: 'inspection', ...current });
      }
      const prior = issued.get(ticket);
      const sameScope = prior && JSON.stringify(prior.ids) === JSON.stringify(ids);
      const acceptStale = fault === 'stale-acceptance' && sameScope;
      const acceptOtherScope = fault === 'scope-ignored' && prior && prior.state === JSON.stringify(board);
      const replay = fault === 'duplicate-replay' && sameScope && current.actions.length === 0;
      const valid = ticket === current.ticket || fault === 'ignore-token' || acceptStale || acceptOtherScope || replay;
      if (!valid) {
        if (fault === 'error-after-mutation') complete(current.actions);
        return response({ state: 'rejected', current }, true);
      }
      let applied = replay ? prior.actions : current.actions;
      if (fault === 'concurrent-double-write') await pause();
      if (fault === 'partial-effect') applied = applied.slice(0, 1);
      if (applied.length) complete(applied);
      if (fault === 'extra-effect') complete([{ taskId: 'c', status: 'done' }]);
      return response({ state: 'applied', applied: current.actions });
    });
  });
  const ids = ['a', 'b'];
  return {
    disposable: true,
    client: connection.client,
    profile: {
      toolName: 'complete_tasks',
      previewArguments: () => ({ ids: [...ids], mode: 'inspect' }),
      commitArguments: ticket => ({ ids: [...ids], mode: 'apply', ...(ticket === undefined ? {} : { ticket }) }),
      invalidToken: reviewedToken => reviewedToken + '-unissued',
      otherScopeArguments: ticket => ({ ids: ['c'], mode: 'apply', ticket }),
      decode: result => {
        const data = structured(result);
        if (data.state === 'inspection') return { kind: 'preview', preview: preview(data.ticket, data.actions) };
        if (data.state === 'applied' && Array.isArray(data.applied)) return { kind: 'committed', plan: data.applied };
        if (data.state === 'rejected') return { kind: 'rejected', ...(data.current ? { preview: preview(data.current.ticket, data.current.actions) } : {}) };
        throw new TypeError('Unrecognized task response');
      },
    },
    observer: {
      snapshot: async () => ({ state: structuredClone(board), writes }),
      change: async () => complete([{ taskId: 'a', status: 'done' }]),
    },
    expected: structuredClone({ initial: INITIAL, plan: PLAN, afterCommit: COMPLETE,
      changed: CHANGED, changedPlan: [{ taskId: 'b', status: 'done' }], afterReconfirm: COMPLETE,
      commitWrites: 1, reconfirmWrites: 1 }),
    close: connection.close,
  };
}
