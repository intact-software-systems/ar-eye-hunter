# API-v1 Group-State Boundary Navigation Map

This directory owns the HTTP boundary for authoritative group state: route
registration, request decoding, the request-to-command translation, and error
mapping. The durable service, mutation pipeline, and dissemination owners live
in `packages/shared-server/rallar-system/group-state`; this map covers the
api-v1 side a boundary change (flags, admission, response contracts) touches.

## Read First

1. [registerGroupStateRoutes](./register-group-state-routes.ts#registerGroupStateRoutes)
   installs the five cohesive route families once: read, aggregate mutation,
   admission, membership, and presence.
2. [toGroupStateCommand](./to-group-state-command.ts#toGroupStateCommand) is
   the canonical HTTP request-to-AppInbox command boundary for all
   authenticated group mutations.
3. [registerGroupAdmissionRoutes](./register-group-admission-routes.ts#registerGroupAdmissionRoutes)
   owns join, invite-accept, join-code-rotate, and invite create/revoke —
   the join-admission surface.
4. [registerGroupPresenceRoutes](./register-group-presence-routes.ts#registerGroupPresenceRoutes)
   owns presence connect, heartbeat, and disconnect.
5. [registerGroupStateReadRoutes](./register-group-state-read-routes.ts#registerGroupStateReadRoutes)
   owns list/point snapshot reads and event listing;
   [readGroupSnapshotPointQuery](../routes/state-snapshot-read-query.ts#readGroupSnapshotPointQuery)
   decodes the revision-floored resync pull
   (`minGroupRevision`/`minPresenceRevision`).
6. [createStateApiResilienceMiddleware](../services/state-api-resilience-middleware.ts#createStateApiResilienceMiddleware)
   is the blanket `/api/state/*` sliding-window limiter and circuit breaker
   every route here already sits behind.
7. [readApiGroupFormationDampingConfig](../runtime/group-formation/group-formation-damping-config.ts#readApiGroupFormationDampingConfig)
   is the flag-parsing convention (typed union intent, startup log) that new
   group-formation flags follow.
8. [toGroupStateErrorResponse](./group-state-route-errors.ts#toGroupStateErrorResponse)
   maps typed policy denials (including `group-full`) and inbox failures to
   HTTP responses.

## Boundaries

Route handlers stay under 30 lines and delegate policy to the shared-server
compute phase; contractual request defaults live in
`resources/api-v1-openapi.yaml` and are reapplied by the boundary decoders.
