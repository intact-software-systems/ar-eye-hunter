# Manual review follow-up: authorization and isolation hardening

Status: Draft — manual approval required.

Findings: SEC-008, SEC-009, SEC-011, COR-006, COR-015.

Audit baseline: `fd0f4e9219f80b4bee7cb8336d26b0e0d5d6aea1`. Remediation base:
`codex/repository-audit-remediation`. Plan creation does not authorize policy
or migration implementation.

Before implementation, owners must decide object authorization policy for CRDT
documents, workspace identifier semantics, forwarding-header trust, graph
diagnostic visibility, and uniform request-size limits. The implementation
must add negative cross-scope tests for in-memory, PGlite, Postgres, and HTTP
paths, then run API black-box recipes and persistence parity checks.

Validation commands: API-v1 typecheck, focused route/repository tests,
`npm run test:api-v1:black-box:memory`, and persistence parity tests.
