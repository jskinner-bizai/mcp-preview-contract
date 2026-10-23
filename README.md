# MCP Preview Contract

Test that an MCP tool changes only the state a caller reviewed, and refuses an outdated confirmation without writing. The runner compares actual fixture state and an independently instrumented mutation journal with fixture-owned expected results. It does not trust a server's `writeApplied` flag or success text.

This is a reusable, optional **application profile**, `preview-confirm-v1`. Preview tokens are not an MCP requirement, authentication, or evidence of human review. Passing these checks is not MCP certification or a production security guarantee.

## Run the examples

Use Node.js 20 or later. From this standalone project directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
```

The lockfile pins the MCP TypeScript SDK and Zod. An offline install requires the exact dependency tarballs to be cached already. No build step, credentials, browser, external service or paid API is needed by the examples.

Choose one example, or write a JSON receipt for CI:

```sh
node bin/mcp-preview-contract.mjs demo inventory
node bin/mcp-preview-contract.mjs demo tasks
node bin/mcp-preview-contract.mjs demo all > contract-receipt.json
```

The CLI accepts only these disposable built-in examples. It has no endpoint, shell-command or arbitrary adapter-file option.

| Example | Application and adapter differences |
| --- | --- |
| Assembly-kit inventory | `reserve_kit` previews with `dry_run`, confirms with `expected_token`, reduces available part quantities and adds reserved kit lines. |
| Task completion | `complete_tasks` uses `mode: inspect` or `apply` and a `ticket`; its effects update existing task statuses. |

Both examples connect real SDK `Client` and `McpServer` instances through `InMemoryTransport`. Their tool arguments, response envelopes and state effects differ. They use synthetic parts and task IDs, not Household Brain data or live accounts.

## Use the library

```js
import { runPreviewContract } from './src/index.mjs';
import { createTaskFixture } from './examples/tasks.mjs';

const receipt = await runPreviewContract({
  name: 'task-completion',
  createFixture: createTaskFixture,
  timeoutMs: 2000,
  observationWindowMs: 50,
});

console.log(JSON.stringify(receipt, null, 2));
process.exitCode = receipt.passed ? 0 : 1;
```

`src/index.d.ts` describes the public API. To test another tool, supply a fixture factory with the following parts:

| Part | Responsibility |
| --- | --- |
| `disposable: true` | Declare that this fixture owns isolated, expendable state. This flag cannot establish isolation by itself. |
| `client` | Provide `listTools` and `callTool`. The examples use actual SDK clients. |
| `profile` | Map preview, confirmation and different-scope arguments; provide `invalidToken(reviewedToken)`; decode application results into `preview`, `committed` or `rejected`. Tokens are opaque nonempty strings, not a prescribed hash format. |
| `observer.snapshot()` | Read the backing state and monotonic mutation-journal count independently of the tool result. Return `{ state, writes }`. |
| `observer.change()` | Make a real, instrumented change to relevant fixture state between preview and confirmation. |
| `expected` | Supply independent literals for the initial state, proposed changes, committed state, intervening state, revised proposal and reconfirmed state, plus expected journal-entry counts. |
| `close()` | Release this fixture's clients, servers and other resources. |

The runner calls the factory separately for every scenario. Factories must actually create fresh state and clean up their own resources; returning the same shared object for every call defeats isolation. See the two example factories for complete adapters.

Expected state must come from the fixture's known seed and intended operation, not by copying the server's preview or calculating expectations from its success response. The sample fixtures keep literal expected states separately from their server handlers. The journal counts declared mutation operations, such as a batch reservation, rather than assuming one entry per item.

The required `profile.invalidToken(reviewedToken)` hook must return a schema-valid, unissued token distinct from the reviewed token. The invalid-token scenario obtains a real preview first, calls this hook, then submits a confirmation under the original scope. A generic bogus string could be rejected by a valid server's input schema, such as a schema requiring 64 hexadecimal characters, without testing the application's token validation. The adapter chooses a suitable invalid token; the harness assumes no standard token format and cannot independently establish that the adapter's token was never issued.

This profile deliberately requires positive initial and revised proposals, explicit application-level rejection results, and an empty repeat preview after the intended changes. A server can be valid MCP while implementing a different application contract. A protocol validation error is recorded as such; it does not pass the profile's application-rejection check.

## Scenarios

| Scenario | What the runner checks |
| --- | --- |
| `discovery` | The mapped tool is advertised through bounded, non-looping pagination; discovery changes neither observed state nor the journal. |
| `preview_read_only` | The returned proposal matches the independent oracle, with no observed state change or journal increment. |
| `missing_token` | A confirmation without its token is explicitly rejected without an observed mutation. |
| `invalid_token` | After a real preview, the adapter supplies a distinct, schema-valid unissued token. Confirmation under the original scope is explicitly rejected without an observed mutation. |
| `scope_binding` | A token issued for the original request cannot authorize a different scope. |
| `commit_effects` | Confirmation reports the reviewed proposal and produces exactly the expected state and journal delta. |
| `stale_reconfirmation` | An independent intervening change invalidates the old confirmation; rejection writes nothing and returns a revised proposal for a separate confirmation. |
| `duplicate_confirmation` | Reusing an already-used confirmation adds no observed effect or journal entry. |
| `repeat_preview` | A new preview after confirmation proposes no further changes and remains read-only. |
| `concurrent_confirmation` | Two concurrent confirmations produce the allowed final state and only the expected mutation count in the exercised schedule. |

The test sources also include deliberately faulty synthetic fixtures to check that the runner detects misleading previews, ignored or stale tokens, wrong scope, partial or extra effects, duplicate effects, and writes followed by rollback. These fixtures are not exposed as CLI modes. Consult the actual test output for the current results; this document does not assert a test-pass count.

## Receipts and CI

The CLI prints JSON to standard output. Its receipt includes each scenario's pass/fail result, bounded failure code, call phases and outcomes, argument hashes, observed state hashes, mutation delta and cleanup status. It does not print raw tokens, tool arguments, full snapshots or arbitrary exception text. A caller-supplied fixture name is included, so keep names free of private information. Hashes identify values; they are not a secrecy guarantee for predictable data.

The runner repeatedly samples the independent state and mutation journal during a bounded post-response observation window. If the state or journal changes after the scenario's last operation without another requested action, the check fails with `UNREQUESTED_CHANGE_BEFORE_CLEANUP` and sets `finalObservationChanged: true`. Each observation poll adds an entry to the `observations` array with phases like `last-observed-before-cleanup` and `observation-poll-1`. An unavailable, invalid or backward-moving observation also fails the check.

The observation window can detect writes that occur within its configured duration, such as delayed mutations scheduled immediately after returning a response. It cannot prove the absence of arbitrarily late writes or writes scheduled after the window closes. A write followed by rollback must fail even when its final state hash is unchanged, because the mutation journal records both operations.

| Exit code | CLI meaning |
| --- | --- |
| `0` | Every selected example's contract checks passed. |
| `1` | A check failed or the demo could not complete. Keep the receipt for diagnosis. |
| `2` | Unsupported command, selection or argument count. |

Library callers receive a receipt and decide their own process exit code. Invalid top-level library options reject the call; fixture or scenario failures are recorded in the receipt.

`canonicalJson` and `stateHash` are also exported. Snapshots and decoded data must be explicit JSON: finite numbers, strings, booleans, null, dense arrays and plain objects. Object keys are sorted; array order remains meaningful. Accessors, symbols, custom prototypes, hidden properties, cycles and sparse arrays are rejected. Limits are 1 MiB of encoded JSON, 10,000 visited nodes and depth 32. This bounded encoding is not an implementation of RFC 8785/JCS and is not a signing format.

## Errors, timeouts and trust

`callOnce(callback, { timeoutMs })` invokes its callback once and reports `result`, `tool-error`, `protocol-error` or `unknown`, with `attempts: 1`. It distinguishes recognized JSON-RPC request errors from tool results carrying `isError: true`; malformed responses and other failures remain unknown. A tool error does not itself prove that no write happened. Contract rejection checks still require recognized application output and an independent unchanged state and journal.

The helper does not invoke the callback again. It cannot prevent retries implemented inside the supplied callback, client or transport. The included examples use the real SDK's in-process transport.

A timeout does **not** cancel the underlying operation. A late operation may still write after the runner's last observation or while cleanup is attempted. The receipt preserves an unknown outcome rather than relabeling it as safe rejection. Do not use this runner against production state, purchases, messages, real user data or other irreversible operations.

### Post-response observation window

After each scenario finishes, the runner samples the state and mutation journal repeatedly during a bounded observation window. A faulty handler may return a preview or rejection and then mutate its backing state on a timer. The observation window can detect writes that occur within its configured duration.

The `observationWindowMs` option defaults to 50 milliseconds with a maximum of 2000. Setting it to 0 disables polling and takes only one final snapshot. Otherwise, an unchanged passing case must take a terminal snapshot starting at or after the window deadline. Polling stops early on a detected change or observation failure. Each asynchronous snapshot is bounded by `timeoutMs`, and the overall audit budget is the window plus one `timeoutMs`; cleanup has its own existing timeout. The runner allows at most `observationWindowMs + 2` audit snapshots (at most 2002). Exhausting this budget without a terminal sample fails the case. JavaScript timers cannot interrupt synchronous observer code or a blocked event loop, and a timeout does not cancel a pending snapshot. If an otherwise passing case observes an unrequested state change or journal increment during this window, it fails with code `UNREQUESTED_CHANGE_BEFORE_CLEANUP`.

This finite window **cannot** prove the absence of arbitrarily late writes, certify MCP compliance, establish human approval or protect production state. It can detect writes that happen within the configured delay but not writes scheduled for hours or days later. Observation is a practical testing aid, not a comprehensive guarantee. The existing timeout and trust limitations remain unchanged.

The runner attempts bounded `close()` cleanup for each returned fixture. Failed cleanup fails the check. If factory creation times out, cleanup is recorded as `pending-factory`; a late returned fixture is scheduled for cleanup, but the receipt does not certify that cleanup completed. Factories must own cancellation, quiescence and resource disposal where their test environment needs them.

Adapters, factories, observers and expected-state oracles are trusted executable test code. The library is not a sandbox and cannot verify that an adapter avoids external services. The observer must cover all relevant application/resource state and mutation paths, including changes that are later rolled back. Equal snapshots alone prove only no net change. The journal does not automatically cover token-issuance caches, telemetry, disk or network writes outside the declared projection.

Concurrency checks exercise one schedule; they do not prove correctness for every interleaving. Observed fixture behavior does not establish authorization, human approval, transport security, production persistence or complete service safety.

## Sources, license and publication status

- [MCP tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): tool discovery, results, structured content, untrusted annotations and the distinction between protocol and tool errors. The preview-bound profile is this project's optional convention.
- [Provenance and contribution scope](PROVENANCE.md): origin, AI assistance and the separate contribution boundary.
- [MIT license](LICENSE), copyright 2026 Jordan Skinner. Dependencies retain their own licenses and notices; this project's MIT file does not relicense them.

The [baseline source at c89abf0](https://github.com/jskinner-bizai/mcp-preview-contract/commit/c89abf0e9210f42912eed6a59108210e87dc208a) is public in the [project repository](https://github.com/jskinner-bizai/mcp-preview-contract). This Kiro-assisted observation-window revision updates that same MIT-licensed project. Check the repository history for the revision's actual publication state; local test receipts alone do not establish publication or a submitted entry. `"private": true` in package.json blocks accidental npm registry publication. No registry release, outside adoption or competition completion is claimed here.
