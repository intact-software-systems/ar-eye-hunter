# API-v1 Group-State Route Structure Lineage Provenance

This temporary exact-base ratchet belongs to the API-v1 group-state route
structure child. Remove or replace it after both implementation PR resulting-main
workflows and the later ledger are published, when semantic coverage owns the
same loss risk.

## Source: `apps/api-v1/src/routes/group-state-routes.ts`

Source blob: `aced85e681666edde414be27b68278ddff53fc42`
Source symbol or line span: `readRequestWithRequestId<T> (lines 1036-1051); presence route callbacks (lines 778-913)`
Source changed regions: `mechanically moved regions only`

### Target: `apps/api-v1/src/group-state/read-group-state-route-request.ts`

Target symbol or line span: `GroupStateRouteRequestContext and readGroupStateRouteRequest<T> (lines 3-20)`
Target changed regions: `mechanically moved regions only`
Mechanical-move classification: `mechanical move`
Semantic additions excluded from inherited capacity: `all other target contents`
Human disposition: `boundary.unknown at request JSON boundary (line 5): inherited and accepted for PR A; Task 7 owns any alignment.`

- `boundary.unknown at request JSON boundary (line 5)`: inherited and accepted
  for PR A; Task 7 owns any alignment.

### Target: `apps/api-v1/src/group-state/register-group-presence-routes.ts`

Target symbol or line span: `connect, heartbeat, and disconnect route callbacks (lines 47-171)`
Target changed regions: `mechanically moved regions only`
Mechanical-move classification: `mechanical move`
Semantic additions excluded from inherited capacity: `all other target contents`
Human disposition: `route.handler-length at callback lines 47, 92, and 137: inherited and accepted for PR A; Task 7 owns any alignment.`

- `route.handler-length at callback line 47`: inherited and accepted for PR A;
  Task 7 owns any alignment.
- `route.handler-length at callback line 92`: inherited and accepted for PR A;
  Task 7 owns any alignment.
- `route.handler-length at callback line 137`: inherited and accepted for PR A;
  Task 7 owns any alignment.

## Source: `apps/api-v1/src/routes/group-state-route-errors.ts`

Source blob: `cd58fb90d1836c33be35f417a6a04376150a2327`
Source symbol or line span: `entire module (lines 1-136)`
Source changed regions: `mechanically moved regions only`

### Target: `apps/api-v1/src/group-state/group-state-route-errors.ts`

Target symbol or line span: `entire module (lines 1-136)`
Target changed regions: `mechanically moved regions only`
Mechanical-move classification: `mechanical move`
Semantic additions excluded from inherited capacity: `all other target contents`
Human disposition: `boundary.unknown at lines 35, 37, 63, 81, 106, and 134: inherited and accepted for PR A; Task 7 owns any alignment.`

- `boundary.unknown at line 35`: inherited and accepted for PR A; Task 7 owns
  any alignment.
- `boundary.unknown at line 37`: inherited and accepted for PR A; Task 7 owns
  any alignment.
- `boundary.unknown at line 63`: inherited and accepted for PR A; Task 7 owns
  any alignment.
- `boundary.unknown at line 81`: inherited and accepted for PR A; Task 7 owns
  any alignment.
- `boundary.unknown at line 106`: inherited and accepted for PR A; Task 7 owns
  any alignment.
- `boundary.unknown at line 134`: inherited and accepted for PR A; Task 7 owns
  any alignment.
