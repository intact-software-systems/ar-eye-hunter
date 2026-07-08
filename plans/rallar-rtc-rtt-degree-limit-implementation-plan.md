# Rallar RTC RTT Degree Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable degree limits to RTC RTT measurements so one client with many retained RTC connections performs and reports at most K RTT measurements, while preserving topology quality and documenting the remaining dense graph-build risks.

**Architecture:** Introduce a shared deterministic RTT reporting policy, wire it into browser heartbeat ownership so non-selected peers do not run RTT heartbeats, and make the server authoritative for accepted RTT pairs. Treat Vivaldi and room graph densification as a separate scalability iteration because sparse RTT inputs can still produce dense predicted or fallback-weighted graphs.

**Tech Stack:** TypeScript, Vitest, Rallar shared packages, shared-web browser middleware, shared-server WS topics, shared-graph topology and Vivaldi services.

## Global Constraints

- Preserve `rtc.maxPeerConnections` as the retained RTC connection cap; do not use it as the RTT measurement cap.
- Add a separate RTT measurement/reporting degree limit K.
- Default K to the effective topology `degreeLimit`, currently `5`.
- Carry the published topology `degreeLimit` into browser `OverlayInfo` so a browser with no explicit `rtc.rttReportingDegreeLimit` follows custom server topology defaults after overlay arrival.
- Browser limiting must stop or avoid RTT heartbeat measurement work for non-selected peers, not only suppress WebSocket RTT messages.
- Server acceptance remains authoritative; browser limiting is a load-reduction optimization.
- Keep current latest-pair storage semantics: unordered pair key, newer version wins, TTL remains in the existing repository path.
- Treat stale versions as storage-layer no-ops: they must not update repositories, Vivaldi state, or topology queues, but they do not need a separate policy rejection reason.
- Keep existing RTT topology debounce and app-inbox coalescing behavior.
- Do not rely on Vivaldi to bound graph size. Vivaldi can infer a complete graph among Vivaldi-known nodes even with sparse measurements.
- Add focused tests before implementation changes in each iteration.

---

## Current Findings

### Vivaldi Predicted Graph Behavior

`packages/shared-graph/graph/vivaldi.ts` currently creates a complete predicted graph over every node in the supplied Vivaldi node-data map:

```ts
for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
        const source = nodes[i];
        const target = nodes[j];
        const weight = predictedRttMs(source, target, cfg);
        upsertPredictedEdge(graph, source.id, target.id, weight);
    }
}
```

This means bounded RTT measurement can reduce input measurement edges from `O(N^2)` to `O(N*K)`, but predicted graph creation can still produce `O(M^2)` edges for `M` Vivaldi-known nodes. A node becomes Vivaldi-known only after at least one valid RTT involving that node is observed.

### Room Topology Graph Behavior

`packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts` also materializes a complete weighted room graph whenever relevant RTT measurements are present:

```ts
for (let i = 0; i < activeSessionIds.length; i++) {
    for (let j = i + 1; j < activeSessionIds.length; j++) {
        const from = activeSessionIds[i];
        const to = activeSessionIds[j];
        graph.addEdge(from, to, {
            from,
            to,
            weight: readRttWeight(rttBySessionId, from, to) ?? fallbackWeight(i, j),
        });
    }
}
```

This is separate from Vivaldi and has the same scalability shape: sparse RTT measurements do not currently imply sparse graph builds.

### Default Degree Recommendation

Use `5` as the default RTT reporting degree limit.

Reasons:

- It matches the current RTC topology default `degreeLimit`.
- It reports all steady-state overlay next hops under the default tree and mesh planners.
- It keeps default star rooms safe because the default star range is below `treeMinSize = 5`, so the largest default star node has degree `3`.
- It bounds heartbeat work to about `N * 5` directed peer heartbeats per interval instead of `N * (N - 1)`.
- It gives enough redundancy for topology quality during churn. A lower default such as `3` is reasonable for constrained deployments, but it should be an explicit operator choice.

## Open Clarifications

1. Should server-side degree enforcement be undirected per endpoint, where a stored pair consumes budget for both clients, or directed per reporter, where only `sessionIdFrom` consumes budget? The recommended v1 is undirected per endpoint because it protects a high-degree node from many inbound reports.
2. Should the first implementation include the sparse graph-build optimization, or should it ship browser/server RTT limiting first and leave graph-build optimization behind metrics and characterization tests? The recommended path is to include graph-build optimization as its own later iteration in this plan, not in the first behavior slice.
3. Should server rejection be strict from day one for over-degree and nonmember RTTs, or should it start in observe-only metrics mode? The recommended path is strict rejection for invalid, self, sender-mismatched, and nonmember RTTs; strict over-degree rejection after browser limiting tests are in place.

## File Map

- Create `packages/shared/rtc/rtt-reporting-policy.ts`: shared deterministic peer selection and degree normalization.
- Modify `packages/shared/mod.ts`: export the shared RTT reporting policy through the package barrel.
- Create `packages/tests/shared/rtc-rtt-reporting-policy.test.ts`: policy tests for defaults, overlay preference, bootstrap determinism, and caps.
- Modify `packages/shared/services/WebRtcRxStreamerService.ts`: own RTT heartbeat reconciliation against selected reporting peers.
- Modify `packages/tests/shared/webrtc-rx-streamer-service.test.ts`: prove non-selected peers do not start or keep RTT heartbeats.
- Modify `packages/shared/services/WebRtcGroupManager.ts`: expose selected RTT reporting peers using overlay first and bootstrap fallback.
- Modify `packages/tests/shared/webrtc-group-manager.test.ts`: prove selected reporting peers are capped and overlay-preferred.
- Modify `packages/shared/api/api-config.ts`: add optional `degreeLimit` to `OverlayInfo`.
- Modify `packages/shared/api/overlay-topology.ts`: copy topology snapshot `degreeLimit` into `toOverlayInfoForSession(...)`.
- Modify `packages/shared-web/browser/rallar-runtime-context.ts`: add `rtc.rttReportingDegreeLimit`.
- Modify `packages/shared-web/browser/middleware.ts`: pass the configured RTT reporting limit and connect group-manager changes to RTT heartbeat reconciliation.
- Modify `packages/tests/shared-web/rallar-runtime-context.test.ts`: prove browser defaults clone and resolve `rttReportingDegreeLimit`.
- Modify `packages/tests/shared-web/rallar-operation-options.test.ts`: prove operation option normalization preserves `rttReportingDegreeLimit`.
- Modify `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`: add `rttReportingDegreeLimit` option with fallback to `degreeLimit`.
- Modify `apps/api-v1/src/services/rtc-topology-config.ts`: read `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`.
- Keep durable group topology config unchanged in v1; `rttReportingDegreeLimit` is a server/runtime option, not a group override.
- Create `packages/shared-server/rallar-system/services/rtc-rtt-measurement-policy.ts`: server-side RTT acceptance policy and reasons.
- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`: use the acceptance policy before latest-pair storage, Vivaldi update, and topology recompute scheduling.
- Modify `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`: rejected RTTs are not stored and do not schedule recomputes.
- Modify `apps/api-v1/test/rtc-topology-config.test.ts`: env-derived server option coverage.
- Modify `packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`: durable latest-pair behavior remains newer-wins after policy-filtered acceptance.
- Modify `packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts`: characterize sparse input producing complete predicted graph among known nodes.
- Modify `packages/tests/shared-graph/group-graph-services.test.ts`: preserve behavior for Vivaldi-unknown nodes.
- Modify `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`: characterize current complete graph with partial RTT and later verify sparse graph optimization.
- Modify `docs/rallar-rtc-rtt-reporting.md`: update once runtime behavior exists.

## Iteration 1: Characterize Current Dense Graph Behavior

**Files:**

- Modify `packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts`
- Modify `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`

**Interfaces:**

- Consumes existing `observeRtt`, `toPredictedGraphFromIds`, `createPredictedGraph`, and `RallarRtcTopologyService.createRoomGraph`.
- Produces tests that protect the analysis: sparse measured RTTs can still lead to dense graphs.

- [ ] **Step 1: Add a Vivaldi sparse-input characterization test**

Add this test to `packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts`:

```ts
it('builds a complete predicted graph among Vivaldi-known nodes after sparse observations', () => {
    observeRtt({
        sessionIdFrom: 'peer-a',
        sessionIdTo: 'peer-b',
        rttMs: 10,
        createdAtEpochMs: 1,
        version: 1,
    });
    observeRtt({
        sessionIdFrom: 'peer-b',
        sessionIdTo: 'peer-c',
        rttMs: 20,
        createdAtEpochMs: 2,
        version: 2,
    });

    const graph = toPredictedGraphFromIds(
        ['peer-a', 'peer-b', 'peer-c'],
        DEFAULT_GRAPH_PROP,
    );

    expect(graph.order).toBe(3);
    expect(graph.size).toBe(3);
    expect(graph.hasEdge('peer-a', 'peer-c')).toBe(true);
});
```

- [ ] **Step 2: Add a room graph characterization test**

Add this test to `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`:

```ts
it('documents complete weighted room graph materialization with partial RTT input', () => {
    const memberSessionIds = createMemberIds(8);
    const group = createGroupSnapshot('room-1', memberSessionIds);
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const graph = service.createRoomGraph(group, [
        {
            sessionIdFrom: 'peer-1',
            sessionIdTo: 'peer-2',
            rttMs: 5,
            createdAtEpochMs: 1,
            version: 1,
        },
    ]);

    expect(graph.order).toBe(8);
    expect(graph.size).toBe((8 * 7) / 2);
    expect(graph.hasEdge('peer-1', 'peer-8')).toBe(true);
});
```

- [ ] **Step 3: Run focused characterization tests**

Run:

```bash
npx vitest run packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts
```

Expected: PASS. These tests document current behavior before the degree-limit work changes adjacent code.

## Iteration 2: Add Shared RTT Reporting Selection Policy

**Files:**

- Create `packages/shared/rtc/rtt-reporting-policy.ts`
- Create `packages/tests/shared/rtc-rtt-reporting-policy.test.ts`
- Modify `packages/shared/mod.ts`

**Interfaces:**

- Produces `DEFAULT_RTT_REPORTING_DEGREE_LIMIT = 5`.
- Produces `normalizeRttReportingDegreeLimit(value, fallback)`.
- Produces `selectRttReportingPeers(input)`.
- Consumed by browser group manager and server acceptance policy.

- [ ] **Step 1: Write policy tests**

Create `packages/tests/shared/rtc-rtt-reporting-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RTT_REPORTING_DEGREE_LIMIT,
    normalizeRttReportingDegreeLimit,
    selectRttReportingPeers,
} from '@shared/rtc/rtt-reporting-policy.ts';

describe('RTT reporting policy', () => {
    it('defaults to the topology degree limit fallback', () => {
        expect(DEFAULT_RTT_REPORTING_DEGREE_LIMIT).toBe(5);
        expect(normalizeRttReportingDegreeLimit(undefined, 4)).toBe(4);
        expect(normalizeRttReportingDegreeLimit(3, 5)).toBe(3);
        expect(normalizeRttReportingDegreeLimit(0, 5)).toBe(5);
        expect(normalizeRttReportingDegreeLimit(1.5, 5)).toBe(5);
    });

    it('selects overlay next hops before bootstrap candidates', () => {
        const result = selectRttReportingPeers({
            localSessionId: 'self',
            degreeLimit: 3,
            overlayNextHopSessionIds: ['peer-c', 'peer-a', 'self'],
            activePeerSessionIds: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
            groupKey: 'app:workspace:room',
        });

        expect(result.selectedPeerIds).toEqual(['peer-a', 'peer-c', 'peer-d']);
        expect(result.degreeLimit).toBe(3);
    });

    it('keeps bootstrap selection deterministic and capped', () => {
        const input = {
            localSessionId: 'self',
            degreeLimit: 2,
            activePeerSessionIds: ['peer-d', 'peer-a', 'peer-c', 'self', 'peer-b'],
            groupKey: 'app:workspace:room',
        };

        expect(selectRttReportingPeers(input).selectedPeerIds)
            .toEqual(selectRttReportingPeers(input).selectedPeerIds);
        expect(selectRttReportingPeers(input).selectedPeerIds).toHaveLength(2);
        expect(selectRttReportingPeers(input).selectedPeerIds).not.toContain('self');
    });
});
```

- [ ] **Step 2: Implement the policy helper**

Create `packages/shared/rtc/rtt-reporting-policy.ts`:

```ts
export const DEFAULT_RTT_REPORTING_DEGREE_LIMIT = 5;

export type RttReportingPeerSelectionInput = Readonly<{
    localSessionId: string;
    degreeLimit?: number;
    fallbackDegreeLimit?: number;
    overlayNextHopSessionIds?: readonly string[];
    activePeerSessionIds?: readonly string[];
    groupKey?: string;
}>;

export type RttReportingPeerSelection = Readonly<{
    degreeLimit: number;
    selectedPeerIds: readonly string[];
}>;

export function normalizeRttReportingDegreeLimit(
    value: number | undefined,
    fallback = DEFAULT_RTT_REPORTING_DEGREE_LIMIT,
): number {
    const candidate = value ?? fallback;
    return Number.isInteger(candidate) && candidate > 0
        ? candidate
        : DEFAULT_RTT_REPORTING_DEGREE_LIMIT;
}

export function selectRttReportingPeers(
    input: RttReportingPeerSelectionInput,
): RttReportingPeerSelection {
    const degreeLimit = normalizeRttReportingDegreeLimit(
        input.degreeLimit,
        input.fallbackDegreeLimit,
    );
    const selected: string[] = [];
    const seen = new Set<string>([input.localSessionId]);

    const add = (peerId: string): void => {
        if (selected.length >= degreeLimit || seen.has(peerId)) return;
        seen.add(peerId);
        selected.push(peerId);
    };

    for (const peerId of stableUnique(input.overlayNextHopSessionIds ?? []).sort()) {
        add(peerId);
    }

    const bootstrapCandidates = stableUnique(input.activePeerSessionIds ?? [])
        .filter((peerId) => !seen.has(peerId))
        .sort((a, b) =>
            rendezvousScore(input.localSessionId, a, input.groupKey)
                .localeCompare(rendezvousScore(input.localSessionId, b, input.groupKey))
        );

    for (const peerId of bootstrapCandidates) {
        add(peerId);
    }

    return { degreeLimit, selectedPeerIds: selected };
}

function stableUnique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function rendezvousScore(
    localSessionId: string,
    peerSessionId: string,
    groupKey = '',
): string {
    return `${hashString(`${groupKey}:${localSessionId}:${peerSessionId}`)}`.padStart(10, '0');
}

function hashString(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
```

- [ ] **Step 3: Run shared policy tests**

Run:

```bash
npx vitest run packages/tests/shared/rtc-rtt-reporting-policy.test.ts
```

Expected: PASS.

- [ ] **Step 4: Export the policy helper**

Add this export to `packages/shared/mod.ts` near the other shared service/API exports:

```ts
export * from './rtc/rtt-reporting-policy.ts';
```

## Iteration 3: Wire Browser RTT Heartbeat Limiting

**Files:**

- Modify `packages/shared/services/WebRtcGroupManager.ts`
- Modify `packages/shared/services/WebRtcRxStreamerService.ts`
- Modify `packages/shared/api/api-config.ts`
- Modify `packages/shared/api/overlay-topology.ts`
- Modify `packages/shared-web/browser/rallar-runtime-context.ts`
- Modify `packages/shared-web/browser/rallar-operation-options.ts`
- Modify `packages/shared-web/browser/rallar.ts`
- Modify `packages/shared-web/browser/middleware.ts`
- Modify `packages/tests/shared/webrtc-group-manager.test.ts`
- Modify `packages/tests/shared/webrtc-rx-streamer-service.test.ts`
- Modify `packages/tests/shared-web/rallar-runtime-context.test.ts`
- Modify `packages/tests/shared-web/rallar-operation-options.test.ts`

**Interfaces:**

- Produces browser option `rtc.rttReportingDegreeLimit?: number`.
- Produces middleware option `rttReportingDegreeLimit?: number`.
- Produces `OverlayInfo.degreeLimit?: number` so custom server topology degree defaults reach the browser.
- Produces `WebRtcGroupManager.rttReportingPeerIds(options?)`.
- Produces `WebRtcRxStreamerService.setRttReportingPeerIds(peerIds)`.

- [ ] **Step 1: Add failing group-manager selection tests**

Add tests to `packages/tests/shared/webrtc-group-manager.test.ts`:

```ts
it('selects at most the configured RTT reporting peers from bootstrap room peers', async () => {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new LatestRepository<string, ClientInfo>();
    const rtcQBox = createRtcQBoxHarness('self');
    const manager = new WebRtcGroupManager(
        rtcQBox.service as never,
        groupCache,
        clientCache,
        undefined,
        { maxPeerConnections: 10 },
    );
    for (const peerId of ['peer-a', 'peer-b', 'peer-c', 'peer-d']) {
        clientCache.set(peerId, createClientInfo(peerId, true));
    }

    await manager.acceptGroupUpdate(
        createGroupSnapshot(
            'group-1',
            1,
            ['self', 'peer-a', 'peer-b', 'peer-c', 'peer-d'],
        ),
    );

    const selected = manager.rttReportingPeerIds({ degreeLimit: 2 });

    expect(selected).toHaveLength(2);
    expect(selected).not.toContain('self');
});

it('prefers overlay next hops for RTT reporting selection', async () => {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new LatestRepository<string, ClientInfo>();
    const overlayCache = new LatestRepository<string, OverlayInfo>();
    const rtcQBox = createRtcQBoxHarness('self');
    const manager = new WebRtcGroupManager(
        rtcQBox.service as never,
        groupCache,
        clientCache,
        overlayCache,
        { maxPeerConnections: 10 },
    );
    const group = createGroupSnapshot('group-1', 1, [
        'self',
        'peer-a',
        'peer-b',
        'peer-c',
    ]);
    for (const peerId of ['peer-a', 'peer-b', 'peer-c']) {
        clientCache.set(peerId, createClientInfo(peerId, true));
    }

    overlayCache.set(toScopedOverlayId(group.group), createOverlayInfo(group, ['peer-c']));
    await manager.acceptGroupUpdate(group);

    expect(manager.rttReportingPeerIds({ degreeLimit: 1 })).toEqual(['peer-c']);
});
```

Use the existing `createRtcQBoxHarness`, `createClientInfo`, `createGroupSnapshot`, and `createOverlayInfo` helpers in this file. Keep the assertions focused on cap size, self-exclusion, and overlay preference.

Add one more test proving a custom overlay degree is used as the fallback when no explicit RTT reporting limit is supplied:

```ts
it('uses overlay degree limit as RTT reporting fallback', async () => {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new LatestRepository<string, ClientInfo>();
    const overlayCache = new LatestRepository<string, OverlayInfo>();
    const rtcQBox = createRtcQBoxHarness('self');
    const manager = new WebRtcGroupManager(
        rtcQBox.service as never,
        groupCache,
        clientCache,
        overlayCache,
    );
    const group = createGroupSnapshot('group-1', 1, [
        'self',
        'peer-a',
        'peer-b',
        'peer-c',
    ]);
    for (const peerId of ['peer-a', 'peer-b', 'peer-c']) {
        clientCache.set(peerId, createClientInfo(peerId, true));
    }

    overlayCache.set(
        toScopedOverlayId(group.group),
        {
            ...createOverlayInfo(group, ['peer-a', 'peer-b', 'peer-c']),
            degreeLimit: 2,
        },
    );
    await manager.acceptGroupUpdate(group);

    expect(manager.rttReportingPeerIds()).toHaveLength(2);
});
```

- [ ] **Step 2: Add failing RX streamer heartbeat tests**

Add tests to `packages/tests/shared/webrtc-rx-streamer-service.test.ts`:

```ts
it('does not start RTT heartbeats for peers outside the reporting set', async () => {
    const service = new WebRtcRxStreamerService(
        new InMemoryQueueBox(new Map()),
        createFakeMulticastManager() as never,
        { sessionId: 'self' },
    );
    service.setRttReportingPeerIds(['peer-1']);

    const peer1 = createPeerDto('peer-1');
    const peer2 = createPeerDto('peer-2');
    service.addPeer(peer1 as never);
    service.addPeer(peer2 as never);

    await peer1.channel.lifecycleCallbacks
        .get('self-peer-1-rtc-datachannel-lifecycle')?.onOpen?.();
    await peer2.channel.lifecycleCallbacks
        .get('self-peer-2-rtc-datachannel-lifecycle')?.onOpen?.();

    expect(mockState.heartbeats).toHaveLength(1);
    expect((mockState.heartbeats[0].input as { peerSessionId: string }).peerSessionId)
        .toBe('peer-1');
});

it('stops RTT heartbeats when a peer leaves the reporting set', async () => {
    const service = new WebRtcRxStreamerService(
        new InMemoryQueueBox(new Map()),
        createFakeMulticastManager() as never,
        { sessionId: 'self' },
    );
    service.setRttReportingPeerIds(['peer-1']);

    const peer = createPeerDto('peer-1');
    service.addPeer(peer as never);
    await peer.channel.lifecycleCallbacks
        .get('self-peer-1-rtc-datachannel-lifecycle')?.onOpen?.();

    service.setRttReportingPeerIds([]);

    expect(mockState.heartbeats[0].stop).toHaveBeenCalledOnce();
});
```

Add a third RX streamer test for the reverse transition:

```ts
it('starts RTT heartbeat for an already-open peer when it enters the reporting set', async () => {
    const service = new WebRtcRxStreamerService(
        new InMemoryQueueBox(new Map()),
        createFakeMulticastManager() as never,
        { sessionId: 'self' },
    );
    service.setRttReportingPeerIds([]);

    const peer = createPeerDto('peer-1');
    service.addPeer(peer as never);
    await peer.channel.lifecycleCallbacks
        .get('self-peer-1-rtc-datachannel-lifecycle')?.onOpen?.();

    expect(mockState.heartbeats).toHaveLength(0);

    service.setRttReportingPeerIds(['peer-1']);

    expect(mockState.heartbeats).toHaveLength(1);
});
```

- [ ] **Step 3: Add browser option plumbing tests**

Extend the existing defaults test in `packages/tests/shared-web/rallar-runtime-context.test.ts` so `rtc.rttReportingDegreeLimit` is cloned and resolved beside `maxPeerConnections`:

```ts
context.setDefaults({
    applicationId: 'app-1',
    rtc: {
        dataChannelLanes: lanes,
        maxPeerConnections: 12,
        rttReportingDegreeLimit: 3,
    },
});

expect(context.defaults()?.rtc).toEqual({
    dataChannelLanes: lanes,
    maxPeerConnections: 12,
    rttReportingDegreeLimit: 3,
});
expect(context.resolveOperationOptions({})).toMatchObject({
    dataChannelLanes: lanes,
    maxPeerConnections: 12,
    rttReportingDegreeLimit: 3,
});
```

Extend `packages/tests/shared-web/rallar-operation-options.test.ts` so normalization preserves the field:

```ts
expect(
    toRallarOperationOptions({
        rttReportingDegreeLimit: 3,
    }),
).toEqual({
    rttReportingDegreeLimit: 3,
});
```

- [ ] **Step 4: Carry topology degree into browser overlay info**

Add `degreeLimit?: number` to `OverlayInfo` in `packages/shared/api/api-config.ts`:

```ts
export type OverlayInfo = {
    readonly overlayId: OverlayId;
    readonly groupRef?: GroupRef;
    readonly topology?: 'star' | 'tree' | 'mesh';
    readonly name: string;
    readonly createdByClientId: string;
    readonly createdAtEpochMs: number;
    readonly nextHopSessionIds: readonly string[];
    readonly degreeLimit?: number;
    readonly overlayVersion: number;
    readonly updatedAtEpochMs: number;
};
```

Copy it in `packages/shared/api/overlay-topology.ts`:

```ts
export function toOverlayInfoForSession(
    snapshot: RallarOverlayTopologySnapshot,
    sessionId: string,
): OverlayInfo {
    return {
        overlayId: snapshot.overlayId,
        groupRef: snapshot.groupRef,
        topology: snapshot.topology,
        name: snapshot.name,
        createdByClientId: snapshot.createdByClientId,
        createdAtEpochMs: snapshot.createdAtEpochMs,
        nextHopSessionIds: snapshot.nextHopsBySessionId[sessionId] ?? [],
        degreeLimit: snapshot.degreeLimit,
        overlayVersion: snapshot.version,
        updatedAtEpochMs: snapshot.updatedAtEpochMs,
    };
}
```

- [ ] **Step 5: Implement browser defaults and middleware options**

Add `rttReportingDegreeLimit?: number` to:

```ts
// packages/shared-web/browser/rallar-runtime-context.ts
rtc?: Readonly<{
    waitTimeoutMs?: number;
    connectOnWait?: boolean;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    maxPeerConnections?: number;
    rttReportingDegreeLimit?: number;
}>;
```

Add it to `MiddlewareInitOptions`:

```ts
export type MiddlewareInitOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    maxPeerConnections?: number;
    rttReportingDegreeLimit?: number;
    scope?: StateScope;
    onAuthInvalid?: (error: unknown) => void | Promise<void>;
    outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
}>;
```

When resolving operation/default RTC options in `packages/shared-web/browser/rallar.ts`, pass `rttReportingDegreeLimit` beside `maxPeerConnections`.

Add it to `RallarOperationOptions` and `toRallarOperationOptions(...)` in `packages/shared-web/browser/rallar-operation-options.ts`:

```ts
export type RallarOperationOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    maxAttempts?: number;
    shouldRetry?: RallarOperationRetryPredicate;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    maxPeerConnections?: number;
    rttReportingDegreeLimit?: number;
}>;
```

Include `options.rttReportingDegreeLimit === undefined` in the empty-options check, add it to the `normalized` object type, and copy it when present:

```ts
if (options.rttReportingDegreeLimit !== undefined) {
    normalized.rttReportingDegreeLimit = options.rttReportingDegreeLimit;
}
```

Add it to `toRefreshOptions(...)` in `packages/shared-web/browser/rallar.ts`:

```ts
...(operationOptions.rttReportingDegreeLimit !== undefined
    ? { rttReportingDegreeLimit: operationOptions.rttReportingDegreeLimit }
    : {}),
```

- [ ] **Step 6: Implement group-manager RTT selection**

In `WebRtcGroupManager`, add:

```ts
export type WebRtcRttReportingPeerOptions = Readonly<{
    degreeLimit?: number;
}>;
```

Add a public method:

```ts
rttReportingPeerIds(options: WebRtcRttReportingPeerOptions = {}): readonly PeerId[] {
    const onlinePeerIds = this.onlinePeerIds();
    const activePeerSessionIds = this.groups()
        .flatMap((group) => group.targetPeerIds())
        .filter((peerId) => onlinePeerIds.has(peerId));

    return selectRttReportingPeers({
        localSessionId: this.rtcQBox.input.sessionId,
        degreeLimit: options.degreeLimit,
        fallbackDegreeLimit: this.overlayRttReportingDegreeLimit(),
        overlayNextHopSessionIds: this.overlayNextHopSessionIds(),
        activePeerSessionIds,
        groupKey: this.groupIds().sort().join('|'),
    }).selectedPeerIds;
}
```

Implement the two private helpers used above:

```ts
private overlayNextHopSessionIds(): readonly PeerId[] {
    const peers: PeerId[] = [];
    for (const group of this.groupsByKey.values()) {
        peers.push(...(this.readOverlayForGroup(group.groupRef)?.nextHopSessionIds ?? []));
    }
    return peers;
}

private overlayRttReportingDegreeLimit(): number | undefined {
    const limits = this.groups()
        .map((group) => this.readOverlayForGroup(group.groupRef)?.degreeLimit)
        .filter((value): value is number => value !== undefined);
    return limits.length > 0 ? Math.min(...limits) : undefined;
}
```

Build `activePeerSessionIds` from every joined group's raw `group.targetPeerIds()`, not from `peerOwners()`. `peerOwners()` already follows overlay next hops, and using it here would prevent the policy from filling unused K capacity with deterministic bootstrap peers when an overlay has fewer than K next hops.

- [ ] **Step 7: Implement RX streamer heartbeat reconciliation**

In `WebRtcRxStreamerService`, add a selected-peer set:

```ts
private rttReportingPeerIds: ReadonlySet<PeerId> | undefined;
```

Add:

```ts
setRttReportingPeerIds(peerIds: readonly PeerId[]): void {
    this.rttReportingPeerIds = new Set(peerIds);
    for (const [peerId, heartbeat] of this.heartbeatByPeerId.entries()) {
        if (!this.shouldReportRttForPeer(peerId)) {
            heartbeat.stop();
            this.heartbeatByPeerId.delete(peerId);
        }
    }
    for (const peerId of peerIds) {
        const dto = this.peerDtoByPeerId.get(peerId);
        if (
            dto?.channel?.isOpen?.() &&
            !this.heartbeatByPeerId.has(peerId)
        ) {
            this.startRtcHeartbeats(peerId).catch((error) =>
                console.error(`Failed to start RTT heartbeat for ${peerId}`, error)
            );
        }
    }
}

private shouldReportRttForPeer(peerId: PeerId): boolean {
    return this.rttReportingPeerIds === undefined ||
        this.rttReportingPeerIds.has(peerId);
}
```

At the start of `startRtcHeartbeats(peerId)`, return without constructing `WebRtcHeartbeatService` when `shouldReportRttForPeer(peerId)` is false.

- [ ] **Step 8: Connect middleware reconciliation**

After `WebRtcGroupManager` is created in `packages/shared-web/browser/middleware.ts`, update the RX streamer selection whenever group/overlay reconciliation can change desired peers:

```ts
const refreshRttReportingPeers = () => {
    rtcRxStreamer.setRttReportingPeerIds(
        webRtcGroupManager.rttReportingPeerIds({
            degreeLimit: options.rttReportingDegreeLimit,
        }),
    );
};
```

Call `refreshRttReportingPeers()` after the group manager is constructed. Add a narrow `onDesiredPeerIdsChanged` callback to `WebRtcGroupManagerOptions` and call it at the end of `reconcileAllGroups()` after connect/disconnect reconciliation has finished; wire that callback to `refreshRttReportingPeers()` from middleware.

- [ ] **Step 9: Run focused browser/shared tests**

Run:

```bash
npx vitest run packages/tests/shared/rtc-rtt-reporting-policy.test.ts packages/tests/shared/webrtc-rx-streamer-service.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts
```

Expected: PASS.

## Iteration 4: Add Server RTT Acceptance Policy And Config

**Files:**

- Create `packages/shared-server/rallar-system/services/rtc-rtt-measurement-policy.ts`
- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Modify `apps/api-v1/src/services/rtc-topology-config.ts`
- Modify `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
- Modify `apps/api-v1/test/rtc-topology-config.test.ts`

**Interfaces:**

- Produces `rttReportingDegreeLimit?: number` server option.
- Produces `resolveRttReportingDegreeLimit(options)`, defaulting to `degreeLimit`.
- Produces `acceptRtcRttMeasurement` result with explicit rejection reasons.

- [ ] **Step 1: Add config tests**

Extend `apps/api-v1/test/rtc-topology-config.test.ts`:

```ts
Deno.test('API RTC topology options read RTT reporting degree from environment', () => {
  const env = fakeEnv({
    RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT: '3',
  });

  assert.deepEqual(getApiRtcTopologyServiceOptions(env), {
    rttReportingDegreeLimit: 3,
  });
});
```

Also extend the invalid-value test with `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT: '0'` and keep the expected output `{}`.

- [ ] **Step 2: Add server rejection tests**

Add to `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`:

```ts
it('rejects RTT measurements from a mismatched AL sender', async () => {
    configureTestCacheRepositories();
    const server = new JsonWebSocketServer();
    const sockets = createSockets(['session-a', 'session-b']);
    for (const [sessionId, socket] of sockets) {
        server.addConnection(new ConnectionContext(sessionId, socket as never));
    }
    const service = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        server,
        'server-1',
    );
    initRallarSystemWsTopics(service);

    const senderSocket = sockets.get('session-a')!;
    await senderSocket.dispatchMessage(
        newALBroadcastMessage(
            'session-a',
            newALEventRoute(AppTopics.rtt, 'room-1', 'rtt-1'),
            'room',
            AppTopics.rtt,
            {
                sessionIdFrom: 'session-b',
                sessionIdTo: 'session-a',
                rttMs: 12,
                createdAtEpochMs: 1,
                version: 1,
            },
        ),
    );

    expect(latestRttById().read('session-a::session-b')).toBeUndefined();
});
```

Add equivalent tests for self-pair, invalid RTT, no shared active group, stale version, non-eligible pair, and over-degree pair. The stale-version test should assert the older measurement is ignored by latest-pair storage and does not trigger Vivaldi or topology recompute; it should not expect a `stale-version` policy reason.

- [ ] **Step 3: Implement server option**

Extend `RallarRtcTopologyServiceOptions`:

```ts
export type RallarRtcTopologyServiceOptions = Readonly<{
    topologyKind?: GroupTopologyKindSetting;
    degreeLimit?: number;
    rttReportingDegreeLimit?: number;
    treeMinSize?: number;
    meshMinSize?: number;
    meshParamK?: number;
    rttRebuildDebounceMs?: number;
    now?: () => number;
}>;
```

Add:

```ts
readRttReportingDegreeLimit(
    options: RallarRtcTopologyServiceOptions = this.options,
): number {
    return normalizeRttReportingDegreeLimit(
        options.rttReportingDegreeLimit,
        this.degreeLimit(options),
    );
}
```

Keep `degreeLimit(...)` private. Expose only `readRttReportingDegreeLimit(...)` as the public method needed by the RTT topic handler.

- [ ] **Step 4: Read API-v1 env var**

In `apps/api-v1/src/services/rtc-topology-config.ts`, read:

```ts
rttReportingDegreeLimit: readPositiveIntegerEnv(
  env,
  'RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT',
),
```

- [ ] **Step 5: Implement acceptance policy helper**

Create `packages/shared-server/rallar-system/services/rtc-rtt-measurement-policy.ts` with:

```ts
export type RtcRttAcceptanceReason =
    | 'accepted'
    | 'invalid-rtt'
    | 'self-pair'
    | 'sender-mismatch'
    | 'not-reporting-edge'
    | 'no-shared-active-group'
    | 'over-degree';

export type RtcRttAcceptanceResult = Readonly<{
    accepted: boolean;
    reason: RtcRttAcceptanceReason;
    affectedGroups: readonly GroupSnapshot[];
}>;
```

The core function should:

```ts
export function evaluateRtcRttMeasurement(input: {
    readonly rtt: RttMeasurementInfo;
    readonly alSenderId: string;
    readonly candidateGroups: readonly GroupSnapshot[];
    readonly overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
    readonly existingMeasurements: readonly RttMeasurementInfo[];
    readonly degreeLimit: number;
}): RtcRttAcceptanceResult
```

Behavior:

- Reject non-finite or `<= 0` RTT.
- Reject `sessionIdFrom === sessionIdTo`.
- Reject when `alSenderId !== rtt.sessionIdFrom`.
- Keep only active groups containing both endpoints.
- Reject when no active shared group exists.
- If a group has an overlay snapshot, run `selectRttReportingPeers(...)` for each endpoint using that endpoint's `snapshot.nextHopsBySessionId[sessionId]` as `overlayNextHopSessionIds`, the active group member set as `activePeerSessionIds`, and the server `degreeLimit`. Reject pairs where neither endpoint's capped selection includes the other. This keeps custom star or override topologies from making acceptance arrival-order dependent when overlay degree exceeds RTT K.
- If a group has no overlay snapshot, use `selectRttReportingPeers(...)` for each endpoint against the active group member set and reject pairs where neither endpoint would select the other.
- Because RTT storage is pair-global rather than group-scoped, reject the measurement if it is ineligible for any shared active group. Otherwise a pair accepted for one group can leak into another shared group's topology input.
- Reject when adding the unordered pair would make either endpoint exceed `degreeLimit` in any shared active group.
- Accept otherwise and return all shared active groups as `affectedGroups`.

- [ ] **Step 6: Use acceptance before storage**

In `initRttTopic(...)`, replace direct storage with:

```ts
const candidateGroups = findGroupsAffectedByRtt(rtt);
const candidateSessionIds = uniqueStrings(
    candidateGroups.flatMap((group) => readGroupMemberSessionIds(group)),
);
const existingMeasurements = runtimeState
    ? await runtimeState.rtts.listMeasurementsForSessionIds(candidateSessionIds)
    : rttRepository.getAllRtt();
const overlaySnapshotsByGroupKey = await readOverlaySnapshotsForGroups(
    candidateGroups,
    rtcTopologyService,
    runtimeState,
);
const acceptance = evaluateRtcRttMeasurement({
    rtt,
    alSenderId: data.id.senderId,
    candidateGroups,
    overlaySnapshotsByGroupKey,
    existingMeasurements,
    degreeLimit: rtcTopologyService.readRttReportingDegreeLimit(),
});
if (!acceptance.accepted) {
    console.warn(`Rejected RTC RTT measurement: ${acceptance.reason}`);
    return;
}
```

Then call `acceptRtcRttMeasurement(...)` only for policy-accepted measurements. If storage returns `false`, treat the measurement as stale or duplicate and return before `vivaldiService.observeRtt(...)`, global graph recompute, or topology scheduling. Schedule recompute work for `acceptance.affectedGroups`, not all groups containing either endpoint.

Use this helper shape for overlay snapshot lookup:

```ts
async function readOverlaySnapshotsForGroups(
    groups: readonly GroupSnapshot[],
    rtcTopologyService: RallarRtcTopologyService,
    runtimeState?: RtcTopologyRuntimeState,
): Promise<ReadonlyMap<string, RallarOverlayTopologySnapshot>> {
    const snapshots = new Map<string, RallarOverlayTopologySnapshot>();
    for (const group of groups) {
        const snapshot = runtimeState
            ? await runtimeState.topologySnapshots.findSnapshot(group.group)
            : rtcTopologyService.readSnapshot(group);
        if (snapshot) {
            snapshots.set(toWebRtcGroupKey(group.group), snapshot);
        }
    }
    return snapshots;
}
```

Import `toWebRtcGroupKey(...)` from `@shared/api/api-type-utils.ts` and use the same scoped key on both producer and consumer sides of the map.

- [ ] **Step 7: Run focused server tests**

Run:

```bash
npx vitest run packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts
cd apps/api-v1 && deno test --allow-env --allow-read test/rtc-topology-config.test.ts
```

Expected: PASS.

## Iteration 5: Keep Runtime-State And In-Memory RTT Paths Equivalent

**Files:**

- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`
- Reuse `RtcRttRepository.listMeasurementsForSessionIds(...)`; do not add a repository API in this iteration.
- Modify `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
- Modify `packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`

**Interfaces:**

- Consumes `evaluateRtcRttMeasurement`.
- Produces identical acceptance behavior for runtime-state and process-local RTT storage.

- [ ] **Step 1: Add paired mode tests**

In `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`, add two tests with the same invalid over-degree input:

Use these assertions in the in-memory test after sending `session-a -> session-b` and then `session-a -> session-c` with `rttReportingDegreeLimit: 1`:

```ts
expect(latestRttById().read('session-a::session-b')).toBeDefined();
expect(latestRttById().read('session-a::session-c')).toBeUndefined();
```

Use these assertions in the runtime-state test after the same message sequence with `FakeRuntimeStateRepository`:

```ts
const durableRtts = new RtcRttRepository(runtimeRepository);
expect(await durableRtts.findMeasurement('session-a', 'session-b')).toBeDefined();
expect(await durableRtts.findMeasurement('session-a', 'session-c')).toBeUndefined();
```

- [ ] **Step 2: Refactor acceptance call sites until both tests pass**

Keep all validation before both:

```ts
rttRepository.setRtt(rtt);
runtimeState.rtts.putMeasurementIfNewer(rtt);
```

Do not add a second validation path inside only one repository.

- [ ] **Step 3: Run paired storage tests**

Run:

```bash
npx vitest run packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts
```

Expected: PASS.

## Iteration 6: Sparse Room Graph Build For RTT-Weighted Topology

**Files:**

- Modify `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Modify `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`
- Reuse existing `packages/shared-graph/group-topology-validation.ts` helpers; do not change graph validation in this iteration.

**Interfaces:**

- Produces a bounded weighted candidate graph for tree/mesh planning.
- Keeps no-RTT optimized paths.
- Keeps output overlay connected and degree-limited.
- Adds edge-count scale tests rather than wall-clock assertions, because CI timing noise would make runtime duration checks brittle.

- [ ] **Step 1: Add sparse graph target tests**

Add to `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`:

```ts
it('builds a sparse weighted candidate graph when RTT reporting is degree bounded', () => {
    const memberSessionIds = createMemberIds(32);
    const group = createGroupSnapshot('room-1', memberSessionIds);
    const service = new RallarRtcTopologyService({
        now: () => 100,
        degreeLimit: 5,
        rttReportingDegreeLimit: 5,
    });

    const measurements = createCentralRttMeasurements(memberSessionIds, 'peer-1')
        .filter((rtt) =>
            rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1'
        )
        .slice(0, 5);

    const graph = service.createRoomGraph(group, measurements);

    expect(graph.order).toBe(32);
    expect(graph.size).toBeLessThanOrEqual((32 * 5) / 2);
});
```

This test should fail before the sparse builder is implemented because the current graph size is `(32 * 31) / 2`.

Add a larger edge-count regression test that does not assert wall-clock time:

```ts
it('keeps RTT-weighted candidate graph edge count linear in room size', () => {
    const memberSessionIds = createMemberIds(200);
    const group = createGroupSnapshot('room-1', memberSessionIds);
    const service = new RallarRtcTopologyService({
        now: () => 100,
        degreeLimit: 5,
        rttReportingDegreeLimit: 5,
    });
    const measurements = createCentralRttMeasurements(memberSessionIds, 'peer-1')
        .filter((rtt) =>
            rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1'
        )
        .slice(0, 5);

    const graph = service.createRoomGraph(group, measurements);

    expect(graph.order).toBe(200);
    expect(graph.size).toBeLessThanOrEqual((200 * 5) / 2);
});
```

- [ ] **Step 2: Implement a sparse candidate graph**

Change `createRoomGraphWithOptions(...)` so it no longer adds every missing fallback edge when `rttMeasurements.length > 0`.

Use this construction:

1. Add all active session nodes.
2. Add accepted RTT edges first.
3. Add deterministic fallback edges from the existing no-RTT tree or mesh planner until the graph is connected.
4. Add additional deterministic fallback candidate edges only while each endpoint degree is below `degreeLimit`.
5. Keep edge count bounded by `(activeSessionIds.length * degreeLimit) / 2` for undirected graphs.

Use the existing `fallbackWeight(i, j)` for fallback edges so behavior remains deterministic.
If the sparse candidate graph cannot be made connected under the configured `degreeLimit`, return the existing no-RTT tree or mesh plan for that update and increment an explicit fallback metric. Do not silently build a complete graph as the fallback for large rooms.

- [ ] **Step 3: Keep topology output bounded**

Run existing topology creation tests and add:

```ts
for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
    expect(nextHops.length).toBeLessThanOrEqual(5);
}
```

to every new sparse-RTT topology case.

- [ ] **Step 4: Run topology tests**

Run:

```bash
npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
```

Expected: PASS.

## Iteration 7: Global Vivaldi Graph Recompute Guardrails

**Files:**

- Modify `packages/shared-graph/graph/vivaldi.ts`
- Modify `packages/shared-graph/vivaldi-service.ts`
- Modify `packages/shared-graph/group-graphs-create-service.ts`
- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify `packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts`
- Modify `packages/tests/shared-graph/group-graph-services.test.ts`

**Interfaces:**

- Keeps existing complete predicted graph available for callers that explicitly request it.
- Adds a sparse or capped predicted graph path for RTT-triggered recompute.
- Prevents unbounded all-pairs global graph work on every accepted RTT update.

- [ ] **Step 1: Add a capped predicted graph test**

Add to `packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts`:

```ts
it('can build a degree-capped predicted graph for Vivaldi-known nodes', () => {
    const nodeDataById = new Map<string, VivaldiNodeData>(
        Array.from({ length: 10 }, (_value, index) => {
            const id = `peer-${index + 1}`;
            return [id, { id, coords: [index, 0], err: 0.1, rttMs: 0 }];
        }),
    );

    const graph = createDegreeCappedPredictedGraph(nodeDataById, DEFAULT_GRAPH_PROP, {
        degreeLimit: 3,
    });

    expect(graph.order).toBe(10);
    for (const node of graph.nodes()) {
        expect(graph.degree(node)).toBeLessThanOrEqual(3);
    }
});
```

- [ ] **Step 2: Add sparse predicted graph implementation**

Add:

```ts
export function createDegreeCappedPredictedGraph(
    nodeDataById: ReadonlyMap<string, VivaldiNodeData>,
    graphProp: GraphProp,
    options: Readonly<{ degreeLimit: number }> & Partial<VivaldiConfig>,
): UndirectedGraph<VertexProp, EdgeProp, GraphProp>
```

Initial implementation should scan all pairs to choose low predicted RTT candidates, because the immediate goal is output size and API separation. Add a performance note in code comments that true large-N CPU improvement needs spatial indexing or candidate sampling.

- [ ] **Step 3: Debounce complete global recompute after accepted RTT**

In `ws-system-topics.ts`, replace unconditional `computeGlobalGraphAndCacheItIfPossible()` with a single coalesced timer scoped inside `initRallarSystemWsTopics(...)`, next to `rtcTopologyFlushTimers`. Do not use a module-level timer, because tests and multiple in-process servers can initialize this topic set more than once.

```ts
let globalGraphRttRecomputeTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleGlobalGraphRttRecompute(delayMs: number): void {
    if (globalGraphRttRecomputeTimer) return;
    globalGraphRttRecomputeTimer = setTimeout(() => {
        globalGraphRttRecomputeTimer = undefined;
        computeGlobalGraphAndCacheItIfPossible();
    }, delayMs);
}
```

Call it from accepted RTT handling:

```ts
scheduleGlobalGraphRttRecompute(
    rtcTopologyService.readRttRebuildDebounceMs(),
);
```

For tests with `rttRebuildDebounceMs: 0`, run the compute immediately:

```ts
if (rtcTopologyService.readRttRebuildDebounceMs() === 0) {
    computeGlobalGraphAndCacheItIfPossible();
} else {
    scheduleGlobalGraphRttRecompute(
        rtcTopologyService.readRttRebuildDebounceMs(),
    );
}
```

- [ ] **Step 4: Run graph tests**

Run:

```bash
npx vitest run packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts packages/tests/shared-graph/group-graph-services.test.ts
```

Expected: PASS.

## Iteration 8: Documentation And Public Surface Cleanup

**Files:**

- Modify `docs/rallar-rtc-rtt-reporting.md`
- Review `docs/README.md`; no change is expected because it already links to the RTT reporting document.
- Modify public export or snapshot tests if new browser/server options become part of the public API.

**Interfaces:**

- Documents actual runtime behavior after implementation.
- Keeps old analysis clear: Vivaldi and topology graph densification are separate from RTT reporting degree.

- [ ] **Step 1: Update RTT reporting docs**

Update `docs/rallar-rtc-rtt-reporting.md` sections:

- Change "analysis only" language to describe implemented behavior.
- Document browser option `rtc.rttReportingDegreeLimit`.
- Document server env var `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`.
- Document default `5` and fallback to topology `degreeLimit`.
- Document server rejection reasons and stale-version ignore behavior.
- Keep the Vivaldi complete-graph caveat.

- [ ] **Step 2: Run markdown and API snapshot checks**

Run:

```bash
git diff --check -- docs/rallar-rtc-rtt-reporting.md docs/README.md plans/rallar-rtc-rtt-degree-limit-implementation-plan.md
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected: PASS. If public API snapshots intentionally change, update the snapshots in the same iteration and include the option names in the change summary.

## End-To-End Verification

Run the focused suite:

```bash
npx vitest run packages/tests/shared/rtc-rtt-reporting-policy.test.ts packages/tests/shared/webrtc-rx-streamer-service.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-web/browser-middleware-rtt.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-graph/vivaldi-and-predicted-graph.test.ts packages/tests/shared-graph/group-graph-services.test.ts
```

Run type and boundary checks:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
(cd apps/api-v1 && deno test --allow-env --allow-read test/rtc-topology-config.test.ts)
(cd apps/api-v1 && deno task check)
```

Run broader suites only after focused tests pass:

```bash
npm run test:unit
```

## Expected Outcome

- A browser with many retained RTC peer connections performs RTT heartbeat measurement for at most K selected peers.
- Browser steady state prefers server-published overlay next hops for RTT measurement.
- Browser bootstrap selection is deterministic and capped before overlay topology arrives.
- The server rejects invalid, self, sender-mismatched, nonmember, non-eligible, and over-degree RTT reports, and ignores stale RTT reports before Vivaldi or topology work.
- Runtime-state and in-memory RTT acceptance use one policy.
- Topology recompute continues to tolerate sparse RTT measurements.
- Sparse RTT input no longer automatically implies complete room graph output after Iteration 6.
- Vivaldi complete predicted graph behavior is documented and guarded by explicit sparse/capped APIs after Iteration 7.
