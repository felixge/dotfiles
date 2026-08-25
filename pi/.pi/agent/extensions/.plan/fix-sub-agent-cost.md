# Fix sub-agent AI Gateway cost estimates

## Problem

`gateway-cost-fallback` estimates costs for finalized AI Gateway assistant messages by applying the equivalent direct model's pricing. Sub-agents run as separate Pi processes with extension discovery disabled, so this fallback never runs in children. Their JSON events contain token usage with zero cost, and the parent faithfully aggregates and reports that zero value.

The current isolation policy is intentional. Child processes disable sessions, extension discovery, skills, prompt templates, and project approval, while exposing only an explicit tool allowlist. The fix must preserve that policy.

## Goal

Estimate AI Gateway costs for finalized sub-agent assistant messages and propagate those estimates through the existing sub-agent dashboard, status results, and parent-session nested usage accounting.

## Non-goals

- Do not enable general extension discovery in sub-agents.
- Do not enable skills or prompt templates in sub-agents.
- Do not change the child tool allowlists.
- Do not duplicate Gateway model mapping or pricing logic in the sub-agent reducer.
- Do not change how completed sub-agent usage is claimed and attributed to parent sessions.
- Do not attempt to price compaction, branch-summary, or incomplete aborted-message usage.

## Design

Keep `--no-extensions`, but explicitly load `gateway-cost-fallback/index.ts` in every child Pi invocation with `--extension`.

Pi treats these options as complementary: `--no-extensions` disables discovery, while explicit extension paths still load. This allows the pure cost fallback to run without loading unrelated global or project extensions.

Resolve the fallback extension to an absolute path relative to `sub-agent/runner.ts` using `import.meta.url`. Do not resolve it relative to the child working directory, since sub-agents can run in arbitrary directories.

The resulting flow is:

1. The child provider reports tokens and zero cost for an AI Gateway response.
2. The fallback handles the child's finalized `message_end` event.
3. It finds an equivalent priced direct model in the child's model registry.
4. It calls Pi's existing `calculateCost()` logic and replaces the message usage.
5. Pi emits the corrected message through the JSON event stream.
6. `sub-agent/runner.ts` aggregates the corrected usage without provider-specific logic.
7. Existing dashboard, history, and `agent_status` code expose the estimated cost.
8. When terminal usage is claimed by `agent_status`, Pi persists it on the parent tool result as nested usage.

Native nonzero costs remain authoritative because the fallback already skips usage with any recorded cost.

## Implementation

### 1. Add an explicit child extension path

Update `sub-agent/runner.ts`:

- Import the URL-to-path helper from `node:url`.
- Define the default absolute path to `../gateway-cost-fallback/index.ts` relative to `import.meta.url`.
- Add a `gatewayCostExtensionPath` option to `ProcessRunnerOptions` so tests can use a deterministic path.
- Store the resolved option on `PiProcessRunner`.
- Add `--extension` and the resolved path to the child argument list while retaining `--no-extensions`.

Keep the extension argument separate from extension discovery. Do not remove or weaken any existing isolation flags.

### 2. Clarify the fallback documentation

Update `gateway-cost-fallback/README.md` and its source comment:

- State that child Pi processes are covered only when the launcher explicitly loads the fallback.
- Preserve the existing limitations around estimates, unsupported mappings, compaction, and branch summaries.

### 3. Extend runner invocation tests

Update `sub-agent/tests/runner.test.ts`:

- Inject a fixed fake fallback path through `ProcessRunnerOptions`.
- Assert that `--no-extensions` remains present.
- Assert that `--extension` is followed by the injected fallback path.
- Assert that the existing session, skills, prompt-template, approval, model, thinking, and tool arguments remain unchanged.

### 4. Cover the pricing-to-reducer boundary

Add a focused test proving that child usage produced after fallback pricing is aggregated correctly:

- Use a finalized assistant message with Gateway provider/model metadata, token usage, and estimated nonzero cost.
- Feed it through `reduceJsonEvent()`.
- Assert all token and cost components are retained.
- Feed multiple finalized messages and assert costs are summed exactly once.

The existing `gateway-cost-fallback` tests remain responsible for model mapping, pricing tiers, cache-write pricing, and preserving native costs. Avoid duplicating those cases in sub-agent tests.

### 5. Verify status attribution remains unchanged

Use existing manager and extension tests to verify:

- A terminal sub-agent snapshot contains the priced aggregate.
- `agent_status` attributes that aggregate once.
- Repeated status calls do not duplicate nested usage.

Only adjust fixtures where necessary to exercise a nonzero estimated child cost. Do not redesign attribution as part of this fix.

## Verification

Run:

```bash
cd gateway-cost-fallback
npm test
npm run typecheck

cd ../sub-agent
npm test
npm run typecheck
```

Also inspect the generated child argument list in tests to confirm that extension discovery remains disabled and only the fallback is explicitly loaded.

For a manual smoke test:

1. Spawn a sub-agent using an `ai-gw-*` model.
2. Wait for completion with `agent_status`.
3. Confirm its dashboard/status usage has a nonzero estimated cost.
4. Confirm the parent tool result contains the same nested usage.
5. Confirm a direct-provider sub-agent still reports its native cost without modification.

## Expected behavior and limitations

After this change, finalized AI Gateway assistant messages in sub-agents receive the same local cost estimate as main-agent messages. Other extensions and skills remain disabled, and agent tools remain unavailable through the existing child tool allowlist.

The estimate still depends on an equivalent priced direct model being present in Pi's catalog. Unsupported Gateway providers or models remain unpriced. Compaction and branch-summary usage remain unpriced because Pi does not expose equivalent replacement hooks. Usage from a child that terminates before a finalized assistant message may also remain unpriced.

A separate accounting concern remains: completed sub-agent usage enters parent session totals only when a terminal run is claimed by `agent_status`. Persisted terminal history that is never claimed is outside the scope of this fix.
