# Trustworthy delivery evidence

## Approved outcome

Deliver one PR for #704, #768 and #737: truthful receive counts, publication-stage evidence independent of permitted carrier conflation, and exact terminal receipt selection. After merge, the next approved independent slice is player-action reliability (#769 and #712). Do not start that slice in this PR.

## Design

Use the existing typed-channel recorder as the sole messages.rtc recorder. Its event data contains message identity and `payload`; preserve local and remote peer identity for topology evidence. Delete the competing raw recording subscription and its state. Update all affected examples, consumers and documentation together. No legacy shape, compatibility alias, migration, deduplication cache or threshold compensation.

Publication acceptance and receiver delivery are distinct. The newest-N scenario must preserve proof of three retained values, displacement of value 1 before any attempt, two admissions per opportunity, and eventual latest-value arrival, while permitting the carrier to conflate intermediate accepted values. Reuse the publication stage and recipe runtime in executable regressions; do not substitute source-name assertions for this proof.

The live-only cluster recipe must use its existing decoded JSON matching to select the correct message's completed receipt. An earlier admitted receipt is insufficient; absence of completion still fails within the unchanged deadline.

## Implementation and validation

1. Reproduce duplicate recording through the connected browser runtime, selecting no message selector and an explicit selector. Assert one canonical event per actual arrival, accurate receiver count, payload and peer provenance, and cleanup/reconnect behavior. Remove the raw owner and update affected recipe contracts; run runtime tests and example consumers.
2. Execute newest-N recipient commands against permitted conflated carrier history and an absent-latest negative case. Verify stage retention, displacement and per-opportunity admission at the real stage boundary. Correct the scenario without changing production carrier semantics or deadlines.
3. Execute the authored terminal receipt wait with admitted-before-completed, unrelated completion and absent completion. Correct the recipe using existing match decoding. Run the real cluster recipe.
4. Run shared-test typecheck, Black Box build and affected unit/browser tests; review every changed file and all recursively changed support files. Independent untouched code remains out of scope. Reuse existing libraries, with no legacy or migration code.
5. Publish one draft PR early; run local and hosted altered recipes, Run GitHub Free Distributed Recipe, selected Hetzner distributed validation, and Branch Release Gate. Keep delivery thresholds unchanged. Inspect raw counters against distinct delivered evidence. Run one fresh whole-branch review, fix findings test-first, then mark ready and wait for maintainer merge.

## Risk and acceptance

The canonical recorded RTC payload shape is an intentional contract replacement approved with this slice. All in-repository consumers move together. Old artifacts remain historical evidence and are not rewritten. A stricter truthful gate may expose real under-delivery; diagnose it rather than compensate thresholds. No authoritative mutation is planned; if exploration introduces one, load its service guidance and expand the required validation before editing.

Current known baseline: 84 focused tests passed before changes. This plan defines scope; the PR owns current delivery evidence. Remove this file in the PR when its outcome is complete.
