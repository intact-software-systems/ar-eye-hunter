# Direct-write check navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/direct-write-check/check-direct-writes.mjs",
    "symbol": "runDirectWriteCheck"
  },
  "results": [
    {
      "path": "scripts/direct-write-check/compute-direct-write-census.mjs",
      "symbol": "computeDirectWriteCensusLines"
    }
  ],
  "failures": [
    {
      "path": "scripts/direct-write-check/compute-direct-write-findings.mjs",
      "symbol": "computeDirectWriteFindings"
    },
    {
      "path": "scripts/direct-write-check/direct-write-registry.mjs",
      "symbol": "validateDirectWriteRegistry"
    }
  ]
}
```

`npm run check:direct-writes` compares the database write surfaces the source holds with
[`docs/app-inbox-direct-write-registry.md`](../../docs/app-inbox-direct-write-registry.md), in both directions. It is a
governance-gate phase. An entry in the registry records that a write exists; it is not an approval.

## Control flow

- [check-direct-writes.mjs#runDirectWriteCheck](./check-direct-writes.mjs#runDirectWriteCheck) reads and validates the
  registry first and stops with `direct-write.registry-invalid` before any analysis when it is malformed. It then loads
  one ts-morph project over the `.ts`, `.tsx`, `.mts` and `.cts` files of `packages/**` and of every `apps/*/src`
  except the five browser apps it names in `BROWSER_APPS` (so a new app is analysed until it is named there), without
  `packages/tests`, `shared-test`, `shared-rtc-bench`, declaration and test files; it computes the fact sets and
  reports every difference. On success it prints the registry census and the entries that differ from the base branch
  (`--base`, default `origin/main`; a missing base prints `base not available` and does not fail).
- [direct-write-registry.mjs](./direct-write-registry.mjs) owns the block format: `toDirectWriteRegistry` reads the one
  fenced block and `validateDirectWriteRegistry` returns every issue, including the rules that keep an `under-review`
  store free of any answer and an `approved` one complete.
- The fact sets, each `computeXxxFacts(project, scope)` over shared walks in
  [direct-write-sites.mjs](./direct-write-sites.mjs):
  [admission-backend-facts.mjs](./admission-backend-facts.mjs) (port implementations, PostgreSQL constructions, port
  writes, wiring imports, row families), [transaction-opener-facts.mjs](./transaction-opener-facts.mjs),
  [sql-write-facts.mjs](./sql-write-facts.mjs) (SQL write files, root handles fed into writes) and
  [repository-write-facts.mjs](./repository-write-facts.mjs) (root repository writes and their callers to a fixed point).
- [compute-direct-write-findings.mjs](./compute-direct-write-findings.mjs) reports `direct-write.unregistered`,
  `direct-write.stale-entry` and `direct-write.changed` (a count, namespace, backend or statement list that moved).

Tests live under [`packages/tests/repo/direct-write-check/`](../../packages/tests/repo/direct-write-check/) and run in
`npm run test:repo-governance`.

## What it does not see

- A write through the queue API (`enqueue`, `enqueueIfAbsent`, `writeIfAbsent`, `replaceIfObserved`): AppInbox and the
  transport both enqueue through it, so a `WS_OUTBOX` row enqueued directly from a new incoming path is not caught.
- A new caller of a registered store higher in the call chain, such as a new WebSocket topic that publishes through the
  router with an outbox fan-out: it reaches the outbound store through ordinary product API.
- A row family whose key is built inline rather than by an exported `toAL...Key` or `toAL...Prefix` builder under
  `packages/shared/alm`, a row added by reusing an existing key builder, and a work topic that
  `AL_ADMISSION_WORK_COMPLETED_RETENTION` does not retain (`AL_INBOUND`, `AL_RECEIPT_DEADLINE` and `AL_RECEIPT_ENDED`
  are seen only through their key builders).
- A repository write called through an interface the registry does not name as a repository contract, and a root
  handle that travels inside an object literal (for example a holder constructed with `{ sql }`).
- A direct write whose author names a root handle `transaction` or `tx`: the exemption for SQL is by parameter name.
- SQL assembled from pieces no single literal holds, and a write to a table that is not a model of
  `apps/api-v1/prisma/schema.prisma`.
- Whether a surface is on an incoming path at all: the check inventories surfaces; the classes in the registry are a
  human reading of the code.
