# Shared Group-State Contract Navigation Map

This directory owns the runtime-agnostic HTTP and dissemination contracts for
authoritative group state. Server assembly, browser consumption, and recipe
tooling all import these shapes; follow the linked source for the executable
validation.

## Read First

1. [GroupEvent](./group-types.ts#GroupEvent) and
   [GroupSnapshot](./group-types.ts#GroupSnapshot) are the durable event and
   full-snapshot contracts every dissemination row carries;
   [GroupStateCausalRevision](./group-types.ts#GroupStateCausalRevision) is the
   `{groupRevision, presenceRevision}` causal pair.
2. [compareGroupCausalRevision](./group-client-views.ts#compareGroupCausalRevision)
   defines the partial order (`equal | dominates | dominated | incomparable`)
   used by every cache-adoption and floor decision. It is a partial order, not
   a gapless sequence — gap detection must not count revisions.
3. [AppTopics](./api-config.ts#AppTopics) names the WS dissemination topics:
   `group-state.event`, `group-state.snapshot`, `group-directory.snapshot`,
   `overlay.topology`.
4. [validateAuthoritativeGroupEvent](./authoritative-state-validation.ts#validateAuthoritativeGroupEvent)
   and
   [validateAuthoritativeGroupSnapshot](./authoritative-state-validation.ts#validateAuthoritativeGroupSnapshot)
   are the exact-shape validators applied at trust boundaries on both runtimes.
5. [WsDeliveryDiagnosticsEvent](../services/ws-queue-box-server-contracts.ts#WsDeliveryDiagnosticsEvent)
   is the per-send delivery diagnostics contract feeding the formation metrics
   recorder, and
   [RallarGroupFormationMetrics](../rtc/group-formation-metrics.ts#RallarGroupFormationMetrics)
   is the metrics shape exposed to the black-box captures.
6. [decideGroupSnapshotCausalRevision](../repository/group-state-snapshot-revision.ts#decideGroupSnapshotCausalRevision)
   is the shared adoption decide (lease-insensitive equal-tuple semantics)
   used by the browser snapshot caches, and
   [toOverlayInfoForSession](./overlay-topology.ts#toOverlayInfoForSession)
   projects a published topology snapshot into the per-session overlay with
   `server` provenance.

## Boundaries

Contracts here are runtime-agnostic: no DOM, no HTTP server, no Postgres.
Authoritative persisted, event, snapshot, and response contracts use mandatory
fields; sparse request inputs live in separate request types in
[state-types.ts](./state-types.ts#CreateGroupRequest).
