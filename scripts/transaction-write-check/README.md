# Transaction write check

`npm run check:transaction-writes` checks authored `packages/**` and
`apps/api-v1/src/**` execution paths for high-confidence work that must happen
before a write-capable transaction starts.

The checker reports:

- `transaction.precomputable-work` for clocks, randomness, serialization,
  hashing, sorting/canonicalization, and named compute/prepare builders reached
  from a resolved transaction callback or transaction-write function;
- `transaction.inner-retry` when a write transaction is opened from a
  retry/attempt loop.

It recognizes PostgreSQL/PGlite `begin` and `transaction` callbacks, the
`runInPSqlTransaction` wrapper, IndexedDB `readwrite` transactions, IndexedDB
upgrade callbacks, and callback identifiers that resolve to authored source.
It inspects the lexical transaction body rather than expanding arbitrary helper
graphs; suspiciously named compute/prepare/serialize/hash helpers still fail at
their call site. Readonly IndexedDB transactions, tests, fixtures, generated/vendor code,
`packages/shared-test/**`, and `packages/shared-rtc-bench/**` are excluded.
Exact PostgreSQL ResourceInbox owners under
`packages/shared-server/queuebox/postgres/**` are governed by their specialized
SQL review and semantic tests instead.

This is intentionally a narrow check. It does not attempt whole-program
provenance, arbitrary helper-body expansion, SQL semantic proof, dynamic
callback resolution, or an exception/fingerprint registry. Human review remains
responsible for ambiguous helpers and database-result refinements. Extend the
checker only with a focused failing fixture and a demonstrated production class
of error.
