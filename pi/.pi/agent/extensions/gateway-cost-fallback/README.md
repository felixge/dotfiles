# Gateway cost fallback

Pi calculates request cost locally from model metadata. The installed `refresh-models` package intentionally omits pricing from generated `ai-gw-*` models because AI Gateway computes its authoritative cost asynchronously in LLMObs.

This extension restores estimated live and persisted cost for normal AI Gateway assistant messages. When a finalized Gateway message has tokens but no cost, it:

1. Finds the equivalent direct model in Pi's runtime catalog.
2. Applies Pi's `calculateCost()` using that model's current rates and tiers.
3. Replaces the finalized message before Pi persists it.

Native Gateway cost always wins if it becomes available later. Unsupported Gateway providers remain unpriced rather than using a guessed mapping.

Child Pi processes receive these estimates only when their launcher explicitly loads this extension. Disabling extension discovery with `--no-extensions` does not prevent an explicit `--extension` path from loading it.

## Limitations

- Values are local estimates based on Pi's direct-model catalog, not negotiated or LLMObs-adjusted cost.
- Pi has no replacement hook for compaction or branch-summary usage, so those entries remain unpriced when generated through Gateway models.
- AI Gateway models without an equivalent direct Pi model remain unpriced.
