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
    },
    {
      "path": "scripts/direct-write-check/validate-direct-write-review-pins.mjs",
      "symbol": "validateDirectWriteReviewPins"
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
  reports every difference. On success it prints the registry census, then every entry and every value of
  `wiringModules`, `repositoryContractModules` and `workTopicConstants` that differs from the registry at the merge
  base of `--base` (default `origin/main`) and `HEAD`; a base it cannot resolve prints `base not available` and does not
  fail.
- [direct-write-registry.mjs](./direct-write-registry.mjs) owns the block format: `toDirectWriteRegistry` reads the one
  fenced block and `validateDirectWriteRegistry` returns every issue, including the rules that keep an `under-review`
  store free of any answer, dated the day the three stores were found, and an `approved` one complete.
- [validate-direct-write-review-pins.mjs](./validate-direct-write-review-pins.mjs) compares the registry with
  [direct-write-review-pins.json](./direct-write-review-pins.json), read from the analysed tree: the approved store ids
  (none), the stores and their states, every registered `transport-direct` surface, and the number of surfaces in each class. An
  approval, a new store, a new or removed `transport-direct` surface, or a surface added or given another class fails
  with `direct-write.registry-invalid` before any analysis until that file changes too.
- The fact sets, each `computeXxxFacts(project, scope)` over shared walks in
  [direct-write-sites.mjs](./direct-write-sites.mjs):
  [admission-backend-facts.mjs](./admission-backend-facts.mjs) (port implementations, PostgreSQL constructions, port
  writes, wiring imports, row families), [transaction-opener-facts.mjs](./transaction-opener-facts.mjs),
  [sql-write-facts.mjs](./sql-write-facts.mjs) (SQL write files, root handles fed into writes, to a fixed point),
  [repository-write-facts.mjs](./repository-write-facts.mjs) (root repository writes and their callers to a fixed point)
  and [queue-write-facts.mjs](./queue-write-facts.mjs) (queue row writes, claims and releases on a queue-typed receiver).
- [compute-direct-write-findings.mjs](./compute-direct-write-findings.mjs) reports `direct-write.unregistered`,
  `direct-write.stale-entry` and `direct-write.changed` (a count, namespace, backend or statement list that moved).

Tests live under [`packages/tests/repo/direct-write-check/`](../../packages/tests/repo/direct-write-check/) and run in
`npm run test:repo-governance`.

## What it does not see

- A queue write through a port declared outside the queue packages: `ALWorkQueuePort.retainIfAbsent` (a new caller of
  it on an incoming path writes `resource_inbox` and is not caught), the inbox and outbox readers of
  `packages/shared/services`, and AppInbox's own `enqueue`. Only a call whose receiver's type `packages/shared/queuebox`
  or `packages/shared-server/queuebox` declares is a fact.
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
  human reading of the code. The review pins make a class change visible; they do not make a class true.
- Evasions by syntax: an opener or write called by element access (`sql['begin'](...)`) or through a bound or
  destructured method, a subclass of the PostgreSQL backend that does not repeat `implements`, and a re-export of a
  wiring module (`export ... from`).
- The state of `main` itself: the check runs in the governance gate of each pull request at that pull request's head,
  not on a `main` push, so two pull requests that each pass alone can leave `main` with source and registry differing
  until the next pull request runs it.
