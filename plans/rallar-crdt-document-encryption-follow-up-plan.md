# Rallar CRDT Document Encryption Follow-Up Plan

Date: 2026-06-04

Status: Core encryption implemented. AES-GCM encrypted update payloads,
encrypted snapshot bodies, keyring-based client decrypt, backup/restore
preservation, and redacted diagnostics exist. Key custody, rotation automation,
revocation UX, and access-loss recovery remain follow-up work.

Related plans:

- `plans/rallar-crdt-product-and-implementation-plan.md`
- `plans/rallar-crdt-production-hardening-companion-plan.md`

## Purpose

Rallar CRDT can store durable update envelopes and snapshots with encrypted
operation payloads and encrypted snapshot bodies. Authorized clients opened with
a CRDT encryption keyring decrypt before merge; the server durable log can
append, dedupe, backup, restore, and export ciphertext without plaintext access.

This plan now tracks the remaining operational work needed before sensitive
collaborative documents depend on encrypted CRDT payloads in production.

## Current Boundary

Until the remaining operational phases are implemented:

- document-type policies should mark sensitive payloads and require encryption
- debug exports should use explicit operator authorization and redaction by
  default
- CRDT delete must not be treated as erasure
- regulated secrets still require a security review for key custody, revocation,
  retention, and access-loss behavior

## Implementation Plan

### Implemented Core

- Added encrypted JSON envelopes using AES-GCM-256.
- Added update-payload encryption/decryption helpers with authenticated envelope
  metadata and plaintext hashes.
- Added snapshot-body encryption/decryption helpers.
- Added browser facade support for encrypt-before-persist/send and
  decrypt-before-merge.
- Preserved durable append idempotency through stable encrypted update hashes.
- Added backup/restore, convergence, and redacted diagnostic tests.

### Phase 1: Threat Model

- Define which metadata remains server-visible.
- Define whether operation payloads, snapshots, or both are encrypted.
- Define key ownership, rotation, revocation, and lost-key behavior.

### Phase 2: Shared Contracts

- Add encryption metadata without changing document identity. Metadata
  validation now exists in `packages/shared/crdt/crdt-hardening.ts`, and
  encrypted payload metadata is validated in `packages/shared/crdt/crdt-codec.ts`.
- Define canonical hash behavior for encrypted payloads. Encrypted update hashes
  cover ciphertext; decrypted client updates recalculate plaintext hashes before
  merge.
- Define redacted diagnostic bundle behavior. Redacted debug bundles now remove
  operation payloads and remain integrity-verifiable.

### Phase 3: Browser And Server Integration

- Encrypt before local persistence and network send. Implemented in
  `packages/shared-web/browser/rallar-crdt.ts`.
- Keep server validation limited to visible envelope metadata. Implemented for
  encrypted operation batches.
- Preserve durable append idempotency and catch-up pagination. Covered by
  encrypted durable-log tests.

### Phase 4: Operations

- Add key-rotation runbooks.
- Add backup/restore tests for encrypted bundles. Implemented for the in-memory
  durable log.
- Add operator diagnostics that do not expose plaintext. Redacted diagnostics now
  remove ciphertext.

## Acceptance

- Encrypted documents converge across authorized replicas.
- Durable append dedupe still works without plaintext server access.
- Debug and backup bundles can be exported safely according to policy.
- Key rotation and access loss are documented and tested before production
  rollout for regulated data.
