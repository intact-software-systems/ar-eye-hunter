# Transaction write check

`npm run check:transaction-writes` checks authored `packages/**` and
`apps/api-v1/src/**` execution paths for high-confidence work that must happen
before a write-capable transaction starts.

The checker reports:

- `transaction.precomputable-work` for clocks, randomness, serialization,
  hashing, sorting/canonicalization, and named compute/prepare builders reached
  from a resolved transaction callback or transaction-write function;
- `transaction.inner-retry` when a write transaction is opened from any loop;
- `transaction.unresolved-provenance` when transaction work invokes a
  caller-supplied function whose behavior cannot be proven locally.

It recognizes PostgreSQL/PGlite `begin` and `transaction` callbacks, the
`runInPSqlTransaction` wrapper, IndexedDB `readwrite` transactions, IndexedDB
upgrade callbacks, AppInbox computed-write callbacks, and callback identifiers
that resolve to authored source.
It inspects the lexical transaction body rather than expanding arbitrary helper
graphs; suspiciously named compute/prepare/serialize/hash helpers still fail at
their call site. Readonly IndexedDB transactions, tests, fixtures,
generated/vendor code, `packages/shared-test/**`, and
`packages/shared-rtc-bench/**` are excluded.
Exact PostgreSQL ResourceInbox owner methods in the analyzer are governed by
their specialized SQL review and semantic tests. Whole files and directories
are not exempt. Arbitrary callback-bearing methods such as `enqueueIf` and
`enqueueOrUpdate` remain fail-closed; a new method is analyzed until its bounded
SQL policy is reviewed and encoded explicitly.

This is intentionally a narrow check. It does not attempt whole-program
provenance, arbitrary helper-body expansion, SQL semantic proof, general
dynamic callback resolution, or an exception/fingerprint registry. Human review remains
responsible for ambiguous helpers and database-result refinements. Extend the
checker only with a focused failing fixture and a demonstrated production class
of error.
