# Transaction write check

`npm run check:transaction-writes` checks authored `packages/**` and
`apps/api-v1/src/**` execution paths for high-confidence work that must happen
before a write-capable transaction starts.

The checker reports:

- `transaction.precomputable-work` for clocks, randomness, serialization,
  hashing, sorting/canonicalization, and named compute/prepare builders reached
  through a resolved transaction callback, transaction-write function, or its
  transitive authored local helper and callback closure;
- `transaction.unresolved-provenance` when a callback reachable from a write
  transaction cannot be resolved to an authored local body;
- `transaction.inner-retry` when a write transaction is opened from a
  retry/attempt loop.

It recognizes PostgreSQL/PGlite `begin` and `transaction` callbacks, the
`runInPSqlTransaction` wrapper, IndexedDB `readwrite` transactions, IndexedDB
upgrade callbacks, and callback identifiers that resolve to authored source.
It follows symbol-resolved authored local helper calls and callback arguments to
a fixed point while preserving the originating transaction boundary. Unknown
dynamic or external callback provenance fails closed. Suspiciously named
compute/prepare/serialize/hash helpers still fail at their call site. Readonly
IndexedDB transactions, tests, fixtures, generated/vendor code,
`packages/shared-test/**`, and `packages/shared-rtc-bench/**` are excluded.
Exact PostgreSQL ResourceInbox owners under
`packages/shared-server/queuebox/postgres/**` are governed by their specialized
SQL review and semantic tests instead.

This is intentionally a narrow check. It does not attempt whole-program
provenance, SQL semantic proof, dynamic callback resolution, or an
exception/fingerprint registry. Human review remains responsible for ambiguous
helpers and database-result refinements. Extend the checker only with a focused
failing fixture and a demonstrated production class of error.
