import { describe, expect, it } from 'vitest';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    computeRttMutation,
    computeTopologyMutation,
    validateRttMutation,
    validateTopologyMutation,
} from '@shared-server/rallar-system/services/rtc-topology-mutations.ts';

describe('RTC topology mutation phases', () => {
    it('computes and validates an absent topology guard deterministically from frozen input', () => {
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const candidate = topologySnapshot(groupRef, 1);
        const input = deepFreeze({
            read: {
                snapshot: null,
                publicationClaim: null,
            },
            candidate,
            publication: null,
        });

        const first = computeAndValidateTopologyTwice(input);
        const second = computeTopologyMutation(input);

        expect(second).toEqual(first);
        expect(first).toMatchObject({
            outcome: 'write',
            snapshotGuard: { expectedRevision: null, candidate },
        });
        if (first.outcome !== 'write') throw new Error('Expected topology write');
        const tampered = {
            ...first,
            snapshotGuard: {
                ...first.snapshotGuard,
                candidate: { ...first.snapshotGuard.candidate, name: 'tampered' },
            },
        };
        expect(() => validateTopologyMutation({ ...input, computed: tampered }))
            .toThrow('differs from canonical');
        expect(() => validateTopologyMutation({ ...input, computed: tampered }))
            .toThrow('differs from canonical');
    });

    it('computes stale RTT rejection deterministically without mutating frozen reads', () => {
        const incoming = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2,
        };
        const input = deepFreeze({
            command: {
                rtt: incoming,
                alSenderId: 'session-a',
                candidateGroups: [],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1,
            },
            read: {
                measurement: {
                    entry: {
                        key: 'pair=session-a%3A%3Asession-b',
                        value: JSON.stringify({ ...incoming, version: 3 }),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 4,
                    },
                    value: { ...incoming, version: 3 },
                },
                endpointAdmissions: [],
                measurements: [{
                    entry: {
                        key: 'from=session-a:to=session-b',
                        value: JSON.stringify({ ...incoming, version: 3 }),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 4,
                    },
                    value: { ...incoming, version: 3 },
                }],
            },
            facts: {
                purgeAfterEpochMs: 10_000,
                requestedAtEpochMs: 2,
            },
        });

        const first = computeAndValidateRttTwice(input);
        const second = computeRttMutation(input);

        expect(second).toEqual(first);
        expect(first).toMatchObject({ outcome: 'rejected', reason: 'stale' });
    });

    it('loads only the durable publication winner and rejects a claim without its snapshot', () => {
        const groupRef = { applicationId: 'app-1', groupId: 'room-1' };
        const snapshot = topologySnapshot(groupRef, 2);
        const publication = {
            publicationId: 'work-1:2:2', workId: 'work-1', groupRef,
            sourceGroupStateRevision: 2, overlayVersion: 2,
            recipientSessionIds: snapshot.activeSessionIds,
            message: { payload: { resource: JSON.stringify(snapshot) } } as never,
            createdAtEpochMs: 2,
        };
        const entry = {
            key: 'snapshot', value: JSON.stringify(snapshot),
            expireAtTimestamp: 1_000, updatedTimestamp: 'now', revision: 3,
        };
        const loadedInput = deepFreeze({
            read: { snapshot: { entry, value: snapshot }, publicationClaim: { publication } },
            candidate: { ...snapshot, name: 'losing retry' },
            publication: { ...publication, publicationId: 'loser' },
        });
        expect(computeAndValidateTopologyTwice(loadedInput))
            .toEqual({ outcome: 'loaded', snapshot, publication });
        const missingSnapshot = deepFreeze({
            read: { snapshot: null, publicationClaim: { publication } },
            candidate: snapshot,
            publication,
        });
        expect(() => computeTopologyMutation(missingSnapshot)).toThrow('has no durable snapshot');
        expect(() => computeTopologyMutation(missingSnapshot)).toThrow('has no durable snapshot');
        const inconsistent = deepFreeze({
            ...loadedInput,
            read: {
                ...loadedInput.read,
                publicationClaim: {
                    publication: { ...publication, recipientSessionIds: ['session-z'] },
                },
            },
        });
        expect(() => computeTopologyMutation(inconsistent)).toThrow('internally inconsistent');
        expect(() => computeTopologyMutation(inconsistent)).toThrow('internally inconsistent');
    });

    it('computes duplicate, advanced, and superseded topology outcomes', () => {
        const groupRef = { applicationId: 'app-1', groupId: 'room-1' };
        const current = topologySnapshot(groupRef, 2);
        const entry = {
            key: 'snapshot', value: JSON.stringify(current),
            expireAtTimestamp: 1_000, updatedTimestamp: 'now', revision: 5,
        };
        expect(computeAndValidateTopologyTwice(deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: current,
            publication: null,
        }))).toMatchObject({ outcome: 'write', observation: 'duplicate' });
        expect(computeAndValidateTopologyTwice(deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: topologySnapshot(groupRef, 3),
            publication: null,
        }))).toMatchObject({ outcome: 'write', observation: 'advanced' });
        expect(computeAndValidateTopologyTwice(deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: topologySnapshot(groupRef, 1),
            publication: null,
        }))).toEqual({ outcome: 'superseded', current });
        const corrupt = deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: { ...current, name: 'different tuple payload' },
            publication: null,
        });
        expect(() => computeTopologyMutation(corrupt)).toThrow('revision conflict');
        expect(() => computeTopologyMutation(corrupt)).toThrow('revision conflict');
    });

    it('computes policy rejection, endpoint-cap rejection, and accepted RTT intents', () => {
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 1, version: 1,
        };
        const group = rttGroupSnapshot(['session-a', 'session-b']);
        const base = {
            command: {
                rtt, alSenderId: 'session-a', candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
            },
            facts: { requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 },
        };
        const emptyRead = { measurement: null, endpointAdmissions: [], measurements: [] };
        expect(computeAndValidateRttTwice(deepFreeze({
            ...base,
            command: { ...base.command, candidateGroups: [] },
            read: emptyRead,
        }))).toMatchObject({ outcome: 'rejected', reason: 'no-shared-active-group' });
        expect(computeAndValidateRttTwice(deepFreeze({
            ...base,
            read: {
                ...emptyRead,
                endpointAdmissions: [{
                    entry: { key: 'endpoint=session-a', value: '', expireAtTimestamp: 60_001, updatedTimestamp: 'now', revision: 1 },
                    value: {
                        endpointId: 'session-a',
                        peers: [{ peerSessionId: 'session-c', expiresAtEpochMs: 60_001 }],
                        version: 1,
                        updatedAtEpochMs: 0,
                    },
                }],
            },
        }))).toMatchObject({ outcome: 'rejected', reason: 'over-degree' });
        const acceptedInput = deepFreeze({ ...base, read: emptyRead });
        const accepted = computeAndValidateRttTwice(acceptedInput);
        expect(accepted).toMatchObject({
            outcome: 'write',
            receipt: { outcome: 'accepted', measurementVersion: 1 },
            recomputeIntents: [{ groupSnapshot: group, rtt }],
        });
        if (accepted.outcome !== 'write') throw new Error('Expected RTT write');
        expect(accepted.endpointGuards.map(({ endpointId }) => endpointId))
            .toEqual(['session-a', 'session-b']);
        const tampered = {
            ...accepted,
            endpointGuards: [...accepted.endpointGuards].reverse(),
        };
        expect(() => validateRttMutation({ ...acceptedInput, computed: tampered }))
            .toThrow('differs from canonical');
        expect(() => validateRttMutation({ ...acceptedInput, computed: tampered }))
            .toThrow('differs from canonical');
    });

    it('computes every RTT policy rejection family twice from frozen authority', () => {
        const group = rttGroupSnapshot(['session-a', 'session-b', 'session-c']);
        const validRtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 1, version: 1,
        };
        const emptyRead = { measurement: null, endpointAdmissions: [], measurements: [] };
        const reportingOverlay = {
            ...topologySnapshot(group.group, 1),
            activeSessionIds: ['session-a', 'session-b', 'session-c'],
            nextHopsBySessionId: {
                'session-a': ['session-c'],
                'session-b': ['session-c'],
                'session-c': ['session-a'],
            },
            degreeLimit: 1,
        };
        const cases = [
            {
                reason: 'invalid-rtt',
                command: { rtt: { ...validRtt, rttMs: 0 }, alSenderId: 'session-a', candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'self-pair',
                command: { rtt: { ...validRtt, sessionIdTo: 'session-a' }, alSenderId: 'session-a', candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'sender-mismatch',
                command: { rtt: validRtt, alSenderId: 'session-c', candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'no-shared-active-group',
                command: { rtt: validRtt, alSenderId: 'session-a', candidateGroups: [], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'not-reporting-edge',
                command: {
                    rtt: validRtt, alSenderId: 'session-a', candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map([[toWebRtcGroupKey(group.group), reportingOverlay]]),
                    degreeLimit: 1,
                },
            },
        ] as const;
        for (const testCase of cases) {
            const input = deepFreeze({
                command: testCase.command,
                read: emptyRead,
                facts: { requestedAtEpochMs: 1, purgeAfterEpochMs: 60_001 },
            });
            expect(computeAndValidateRttTwice(input))
                .toMatchObject({ outcome: 'rejected', reason: testCase.reason });
        }
    });
});

function topologySnapshot(
    groupRef: GroupRef,
    version: number,
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateRevision: version,
        state: 'active',
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId,
        ]),
        groupRef,
        name: 'Room 1',
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
    };
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        if (value instanceof Map) {
            for (const [key, child] of value.entries()) {
                deepFreeze(key);
                deepFreeze(child);
            }
        }
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

function computeAndValidateTopologyTwice(
    input: Parameters<typeof computeTopologyMutation>[0],
) {
    const first = computeTopologyMutation(input);
    const second = computeTopologyMutation(input);
    expect(second).toEqual(first);
    expect(() => validateTopologyMutation({ ...input, computed: first })).not.toThrow();
    expect(() => validateTopologyMutation({ ...input, computed: first })).not.toThrow();
    return first;
}

function computeAndValidateRttTwice(
    input: Parameters<typeof computeRttMutation>[0],
) {
    const first = computeRttMutation(input);
    const second = computeRttMutation(input);
    expect(second).toEqual(first);
    expect(() => validateRttMutation({ ...input, computed: first })).not.toThrow();
    expect(() => validateRttMutation({ ...input, computed: first })).not.toThrow();
    return first;
}

function rttGroupSnapshot(sessionIds: readonly string[]): GroupSnapshot {
    const groupRef = { applicationId: 'app-1', groupId: 'room-1' };
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: {
            ...groupRef, displayName: 'Room 1', kind: 'room', status: 'active',
            joinMode: 'open', metadata: {}, snapshotVersion: 1, metadataVersion: 1,
            rosterVersion: 1, presenceVersion: 1,
            created: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        },
        members: sessionIds.map((sessionId) => ({
            ...groupRef, principalId: sessionId, role: 'member' as const,
            status: 'active' as const,
            joined: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            ...groupRef, sessionId, principalId: sessionId,
            generationId: `${sessionId}-generation`, generationVersion: 1,
            connectedAtEpochMs: 1, lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}
