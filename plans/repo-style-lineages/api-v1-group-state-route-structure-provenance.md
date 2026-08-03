# API-v1 Group-State Route Structure Lineage Provenance

Merge base: `0a52ecee39181c7784fa6b777270f8a59bc33c00`

This temporary exact-base ratchet belongs to the API-v1 group-state route
structure child. Remove or replace it after both implementation PR resulting-main
workflows and the later ledger are published, when semantic coverage owns the
same loss risk.

The focused governance test independently reads every predecessor span from this
merge base, verifies its SHA-256 content hash, verifies every target span and
hash from the current tree, and fails before this prose can waive a content
change. Regions not named `inherited` below are excluded from lineage capacity.

## Source: `apps/api-v1/src/routes/group-state-routes.ts`

Source blob: `aced85e681666edde414be27b68278ddff53fc42`

### Target: `apps/api-v1/src/group-state/read-group-state-route-request.ts`

- Region `request-reader` is inherited: predecessor
  `readRequestWithRequestId<T>` lines 1036-1051, SHA-256
  `ca43baaef3247486087c8b5adbaa0dcb8a6fc4057ca269cb201bf7c4bce33ef0`;
  target `GroupStateRouteRequestContext` plus
  `readGroupStateRouteRequest<T>` lines 3-21, SHA-256
  `b8c1b8bc3e971c4076bd45908b3434373513c152a574109d70caa8b8cdb08a27`.
- Excluded target region: line 1-2 import boundary. It has no inherited
  capacity.
- Accepted finding: `boundary.unknown at request JSON boundary (line 5)` is
  inside `request-reader`; inherited and accepted for PR A. Task 7 owns any
  alignment.

### Target: `apps/api-v1/src/group-state/register-group-presence-routes.ts`

- Region `presence-connect` is inherited: predecessor callback lines 780-819,
  SHA-256
  `03bc151a40f78c12c06683afb3a02279412fb4524318fb84848ca19b5913a6ca`;
  target callback lines 47-81, SHA-256
  `886f24cee805a803567718d5437a84e3956d2d9515aed058d0b10186635b3841`.
- Region `presence-heartbeat` is inherited: predecessor callback lines 824-865,
  SHA-256
  `cc2809a75ea86071741752fdec940b2b269fe092049e137687ccb3ea4ffa93fb`;
  target callback lines 92-126, SHA-256
  `6e7b6bee51ea4b89f79d9d6257042c7b596ab8daebd5b969a9541a19155fc535`.
- Region `presence-disconnect` is inherited: predecessor callback lines 870-911,
  SHA-256
  `7561ad8b51755ed2931832499fbac340612c420fbc8abe764aff4948dc1134db`;
  target callback lines 137-171, SHA-256
  `814fd81590f77da29a642920cbf984d18cbb7675496a10549f5d037728c76593`.
- Excluded target regions: lines 1-46, 82-91, 127-136, and 172-173. They have
  no inherited capacity.
- Accepted findings: `route.handler-length at callback line 47`,
  `route.handler-length at callback line 92`, and
  `route.handler-length at callback line 137` are inside their matching named
  regions; each is inherited and accepted for PR A. Task 7 owns any alignment.

## Source: `apps/api-v1/src/routes/group-state-route-errors.ts`

Source blob: `cd58fb90d1836c33be35f417a6a04376150a2327`

### Target: `apps/api-v1/src/group-state/group-state-route-errors.ts`

- Region `route-errors` is inherited: predecessor and target each cover the
  complete lines 1-136, SHA-256
  `bc6cc7104612ad032674e896d6d3d987cbe4aca2c25625f98ee9b0de7b1c67ef`.
- Excluded target regions: none.
- Accepted findings: `boundary.unknown at line 35`,
  `boundary.unknown at line 37`, `boundary.unknown at line 63`,
  `boundary.unknown at line 81`, `boundary.unknown at line 106`, and
  `boundary.unknown at line 134` are inside `route-errors`; each is inherited
  and accepted for PR A. Task 7 owns any alignment.

## Compatibility files

- `apps/api-v1/src/routes/group-state-routes.ts` exists and is exactly the
  direct one-hop export-only content with SHA-256
  `a89164e9e36e885dd330b319e589057bd88dd6d2fe90eb63abb626b4f6971665`.
- `apps/api-v1/src/routes/group-state-route-errors.ts` exists and is exactly the
  direct one-hop export-only content with SHA-256
  `2d2d138be4decdc938c61641353289f61fd590fd363927d7187ee07779e89869`.
