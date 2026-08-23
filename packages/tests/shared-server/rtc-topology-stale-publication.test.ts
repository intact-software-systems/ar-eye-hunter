import { computeTopologyMutation, validateTopologyMutation } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';

describe('stale RTC topology publication', () => {
    it('persists an immutable older publication without regressing the latest snapshot', () => {
        const ref: GroupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const candidate = snapshot(ref, 3);
        const current = snapshot(ref, 4);
        const publication = toPublication(candidate, 'work-3');
        const input = {
            read: {
                snapshot: {
                    entry: {
                        key: 'snapshot',
                        value: JSON.stringify(current),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: 'now',
                        revision: 7
                    },
                    value: current
                },
                publicationClaim: null
            },
            candidate,
            publication,
            facts: {
                publicationExpireAtTimestamp: 20_000,
                commandHash: `sha256:${'a'.repeat(64)}`,
                attemptCount: 1
            }
        } as const;

        const computed = computeTopologyMutation(input);

        expect(computed).toMatchObject({
            outcome: 'publish-superseded',
            currentGuard: { expectedRevision: 7, current },
            publication
        });
        expect(() => validateTopologyMutation({ ...input, computed })).not.toThrow();
    });
});

function snapshot(
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

function toPublication(snapshot: RallarOverlayTopologySnapshot, workId: string) {
    const tuple = snapshot.sourceGroupStateCausalRevision;
    const createdAtEpochMs = 100;
    return {
        publicationId: `${workId}:${tuple.groupRevision}:${tuple.presenceRevision}:${snapshot.version}`,
        workId,
        groupRef: snapshot.groupRef,
        sourceGroupStateCausalRevision: tuple,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 1,
        recipientSessionIds: snapshot.activeSessionIds,
        message: {
            id: {
                v: 2 as const,
                msgId: toRtcTopologyPublicationMessageId(workId),
                ts: createdAtEpochMs,
                senderId: 'rallar-server'
            },
            route: {
                topicId: AppTopics.overlayTopology,
                contextId: snapshot.groupRef.groupId,
                resourceId: `${snapshot.overlayId}:${tuple.groupRevision}:${tuple.presenceRevision}:${snapshot.version}`
            },
            targets: {
                mode: 'broadcast' as const,
                scope: 'room' as const,
                groupRef: snapshot.groupRef,
                minSnapshotVersion: 1
            },
            delivery: { reliability: 'best-effort' as const, ack: 'none' as const },
            payload: {
                typeId: AppTopics.overlayTopology,
                contentType: 'application/json' as const,
                resource: JSON.stringify(snapshot)
            },
            audit: { createdBy: 'rallar-server', createdTs: createdAtEpochMs }
        },
        createdAtEpochMs
    };
}
