# Manual review follow-up: game delivery and Relic server coverage

Status: Draft — manual approval required.

Findings: COR-001 and PERF-003; Iteration 09 also found no colocated Relic
server test modules.

Audit baseline: `fd0f4e9219f80b4bee7cb8336d26b0e0d5d6aea1`. Remediation base:
`codex/repository-audit-remediation`. Plan creation does not authorize
implementation.

Define mobile cold-start budgets and hidden-state disclosure policy. Add a
server-focused test suite, redacted public snapshot tests, and measured bundle
budgets before attempting lazy loading or scene splitting. Validate browser
startup and degraded/offline behavior after optimization.

Validation commands: Relic unit/browser suites, server Deno tests, both Vite
production builds, and measured mobile cold-load/bundle-budget checks.
