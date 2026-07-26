import { describe, expect, it } from 'vitest';

import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/rtc-topology-publication-contract.ts';
import {
    toRtcTopologyPublicationId,
    toRtcTopologyPublicationMessageId,
} from '@shared-server/rallar-system/rtc-topology-identifiers.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/services/rtc-topology-ws-outbox-entry.ts';

describe('RTC topology publication WS outbox entry', () => {
    it('bounds its persistence key without changing the published AL route', () => {
        const publication = longRoutePublication();
        expect(publication.message.route.resourceId.length).toBeGreaterThan(128);

        const entry = computeRtcTopologyPublicationOutbox(publication);
        const persistedMessage = JSON.parse(entry.resource) as {
            route: typeof publication.message.route;
        };

        expect(entry.key).toEqual(toAppQueueKey({
            topicId: publication.message.route.topicId,
            resourceId: publication.message.id.msgId,
            contextId: publication.message.route.contextId,
        }));
        expect(entry.key.resourceId.length).toBeLessThanOrEqual(36);
        expect(persistedMessage.route).toEqual(publication.message.route);
    });

    it('assigns distinct physical keys to publications sharing one logical route', () => {
        const first = longRoutePublication('topology-work-1');
        const second = longRoutePublication('topology-work-2');

        const entries = [first, second].map(computeRtcTopologyPublicationOutbox);
        const messages = entries.map((entry) => JSON.parse(entry.resource) as {
            id: { msgId: string };
            route: typeof first.message.route;
        });

        expect(entries[0].key).not.toEqual(entries[1].key);
        expect(entries.every((entry) => entry.key.resourceId.length <= 36)).toBe(true);
        expect(messages[0].route).toEqual(messages[1].route);
        expect(messages[0].id.msgId).not.toBe(messages[1].id.msgId);
        expect(new Map(entries.map((entry) => [JSON.stringify(entry.key), entry])).size).toBe(2);
    });
});

function longRoutePublication(workId = 'medium-scale-topology-work'): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'medium-scale-application'.repeat(2),
        workspaceId: 'medium-scale-workspace'.repeat(2),
        groupId: 'medium-scale-group'.repeat(2),
    };
    const causalRevision = { groupRevision: 141, presenceRevision: 204 };
    const createdAtEpochMs = 1_000;
    const expiresAtMs = 2_000;
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Medium-scale group',
        topology: 'tree',
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        degreeLimit: 2,
        version: 122,
        createdByClientId: 'owner',
        createdAtEpochMs,
        updatedAtEpochMs: createdAtEpochMs,
    };
    const message = {
        id: {
            v: 2 as const,
            msgId: toRtcTopologyPublicationMessageId(workId),
            ts: createdAtEpochMs,
            senderId: 'rallar-server',
        },
        route: {
            topicId: AppTopics.overlayTopology,
            resourceId:
                `${snapshot.overlayId}:${causalRevision.groupRevision}:` +
                `${causalRevision.presenceRevision}:${snapshot.version}`,
            contextId: groupRef.groupId,
        },
        constraints: { expiresAtMs },
        targets: {
            mode: 'broadcast' as const,
            scope: 'room' as const,
            groupRef,
            minSnapshotVersion: 101,
        },
        delivery: {
            reliability: 'best-effort' as const,
            ack: 'none' as const,
        },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json' as const,
            resource: JSON.stringify(snapshot),
        },
        audit: { createdBy: 'rallar-server', createdTs: createdAtEpochMs },
    };
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: causalRevision,
            overlayVersion: snapshot.version,
        }),
        workId,
        groupRef,
        sourceGroupStateCausalRevision: causalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 101,
        recipientSessionIds: snapshot.activeSessionIds,
        message,
        createdAtEpochMs,
    };
}
