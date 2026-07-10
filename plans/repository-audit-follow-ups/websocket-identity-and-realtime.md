# Manual review follow-up: WebSocket identity and realtime authority

Status: Draft — manual approval required.

Findings: SEC-003, COR-004, COR-005, COR-008, COR-009, COR-010.

Audit baseline: `fd0f4e9219f80b4bee7cb8336d26b0e0d5d6aea1`. Remediation base:
`codex/repository-audit-remediation`. Plan creation does not authorize changes.

Confirm the deployment threat model for authenticated connection identity,
room/topic authorization, CRDT catch-up pagination, graph semantics, and
Vivaldi numeric bounds. Add sender-mismatch, cross-room, multi-page catch-up,
disconnect, and zero-jitter tests before changing the shared realtime facade.

Validation commands: focused shared-server CRDT/WebSocket tests, API-v1
typecheck, and shared black-box realtime recipes.
