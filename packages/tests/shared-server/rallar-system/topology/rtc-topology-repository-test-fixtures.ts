import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    type RtcTopologyPublicationWorkClaim
} from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { type RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

export function createGroupRef(): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1'
    };
}

export function createPrincipalAuditStamp(atEpochMs: number, principalId: string) {
    return {
        atEpochMs,
        actor: { kind: 'principal' as const, principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}
export function createTopologySnapshot(
    groupRef: GroupRef,
    version: number
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: version,
            presenceRevision: version
        },
        state: 'active',
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId
        ]),
        groupRef,
        name: 'Room 1',
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a']
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2
    };
}

interface TopologyInvariantCase {
    readonly defect: string;
    readonly snapshot: RallarOverlayTopologySnapshot;
}

export function topologyInvariantCases(): readonly TopologyInvariantCase[] {
    const base = createTopologySnapshot(createGroupRef(), 1);
    return [
        { defect: 'overlay-mismatch', snapshot: { ...base, overlayId: 'wrong-overlay' } },
        { defect: 'duplicate-active-session', snapshot: { ...base, activeSessionIds: ['session-a', 'session-a', 'session-b'] } },
        { defect: 'noncanonical-active-session-order', snapshot: { ...base, activeSessionIds: ['session-b', 'session-a'] } },
        { defect: 'inverted-timestamps', snapshot: { ...base, createdAtEpochMs: 3, updatedAtEpochMs: 2 } },
        ...invalidRoutingCases(base),
        ...invalidGraphCases(base),
        ...invalidRemovedTopologyCases(base)
    ];
}

function invalidRoutingCases(base: RallarOverlayTopologySnapshot): readonly TopologyInvariantCase[] {
    return [
        { defect: 'unknown-hop', snapshot: { ...base, nextHopsBySessionId: { 'session-a': ['session-b', 'session-z'], 'session-b': ['session-a'] } } },
        { defect: 'self-hop', snapshot: { ...base, nextHopsBySessionId: { 'session-a': ['session-a', 'session-b'], 'session-b': ['session-a'] } } },
        { defect: 'duplicate-hop', snapshot: { ...base, nextHopsBySessionId: { 'session-a': ['session-b', 'session-b'], 'session-b': ['session-a'] } } },
        { defect: 'nonreciprocal-hop', snapshot: { ...base, nextHopsBySessionId: { 'session-a': ['session-b'], 'session-b': [] } } },
        { defect: 'missing-routing-key', snapshot: { ...base, nextHopsBySessionId: { 'session-a': ['session-b'] } } },
        { defect: 'unknown-routing-key', snapshot: { ...base, nextHopsBySessionId: { ...base.nextHopsBySessionId, 'session-z': [] } } }
    ];
}

function invalidGraphCases(base: RallarOverlayTopologySnapshot): readonly TopologyInvariantCase[] {
    const threeSessions: RallarOverlayTopologySnapshot = {
        ...base,
        activeSessionIds: ['session-a', 'session-b', 'session-c'],
        nextHopsBySessionId: { 'session-a': ['session-b'], 'session-b': ['session-a', 'session-c'], 'session-c': ['session-b'] }
    };
    return [
        {
            defect: 'noncanonical-hop-order',
            snapshot: { ...threeSessions, nextHopsBySessionId: { ...threeSessions.nextHopsBySessionId, 'session-b': ['session-c', 'session-a'] } }
        },
        {
            defect: 'disconnected-graph',
            snapshot: {
                ...base,
                activeSessionIds: ['session-a', 'session-b', 'session-c', 'session-d'],
                nextHopsBySessionId: { 'session-a': ['session-b'], 'session-b': ['session-a'], 'session-c': ['session-d'], 'session-d': ['session-c'] }
            }
        },
        { defect: 'over-degree-graph', snapshot: { ...threeSessions, degreeLimit: 1 } }
    ];
}

function invalidRemovedTopologyCases(base: RallarOverlayTopologySnapshot): readonly TopologyInvariantCase[] {
    return [
        { defect: 'removed-nonempty-edge', snapshot: { ...base, state: 'removed' } },
        { defect: 'removed-missing-routing-key', snapshot: { ...base, state: 'removed', nextHopsBySessionId: { 'session-a': [] } } },
        {
            defect: 'removed-zero-degree-limit',
            snapshot: { ...base, state: 'removed', nextHopsBySessionId: { 'session-a': [], 'session-b': [] }, degreeLimit: 0 }
        }
    ];
}

export function createPublication(
    snapshot: RallarOverlayTopologySnapshot,
    workId: string
): RtcTopologyPublication {
    const sourceRevision = snapshot.sourceGroupStateCausalRevision;
    return {
        publicationId: `${workId}:${sourceRevision.groupRevision}:${sourceRevision.presenceRevision}:${snapshot.version}`,
        workId,
        groupRef: snapshot.groupRef,
        sourceGroupStateCausalRevision: sourceRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 1,
        recipientSessionIds: snapshot.activeSessionIds,
        snapshot,
        expiresAtEpochMs: 10000,
        createdAtEpochMs: 10
    };
}

export function corruptTopologyExecutionReceipt(
    receipt: RtcTopologyPublicationWorkClaim,
    defect: 'identity-only' | 'missing' | 'extra' | 'hash' | 'attempt' | 'causal' | 'storage' | 'event' | 'outbox'
): JsonWireValue {
    if (defect === 'identity-only') {
        return decodeJsonWireValue({
            groupRef: receipt.groupRef,
            workId: receipt.workId,
            publicationId: receipt.publicationId
        }, 'Corrupt topology receipt fixture');
    }
    if (defect === 'missing') {
        const { eventId: _eventId, ...missingEventId } = receipt;
        return decodeJsonWireValue(missingEventId, 'Corrupt topology receipt fixture');
    }
    if (defect === 'extra') {
        return decodeJsonWireValue(
            { ...receipt, snapshot: null },
            'Corrupt topology receipt fixture'
        );
    }
    if (defect === 'hash') {
        return decodeJsonWireValue(
            { ...receipt, commandHash: `sha256:${'0'.repeat(64)}` },
            'Corrupt topology receipt fixture'
        );
    }
    if (defect === 'attempt') {
        return decodeJsonWireValue(
            { ...receipt, attemptCount: 0 },
            'Corrupt topology receipt fixture'
        );
    }
    if (defect === 'causal') {
        return decodeJsonWireValue({
            ...receipt,
            acceptedCausalRevision: {
                ...receipt.acceptedCausalRevision,
                groupRevision: receipt.acceptedCausalRevision.groupRevision + 1
            }
        }, 'Corrupt topology receipt fixture');
    }
    if (defect === 'storage') {
        return decodeJsonWireValue({
            ...receipt,
            acceptedStorageRevision: receipt.acceptedStorageRevision + 1
        }, 'Corrupt topology receipt fixture');
    }
    if (defect === 'event') {
        return decodeJsonWireValue(
            { ...receipt, eventId: 'unexpected-event' },
            'Corrupt topology receipt fixture'
        );
    }
    return decodeJsonWireValue(
        { ...receipt, outboxIds: [] },
        'Corrupt topology receipt fixture'
    );
}

export function reorderJsonObjectKeys<T>(value: T): T {
    return reorderJsonWireValue(
        decodeJsonWireValue(value, 'Reordered topology fixture')
    ) as T;
}

function reorderJsonWireValue(value: JsonWireValue): JsonWireValue {
    if (Array.isArray(value)) {
        return value.map((entry) => reorderJsonWireValue(entry));
    }
    if (!isJsonWireObject(value)) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .reverse()
            .map(([key, entry]) => [key, reorderJsonWireValue(entry)])
    );
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
