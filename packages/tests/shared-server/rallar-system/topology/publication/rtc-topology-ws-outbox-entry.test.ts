import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';
import { assembleStateSnapshotMessages } from '../../../../shared/state-snapshot-test-fixture.ts';

describe('RTC topology publication WS outbox pages', () => {
    it('bounds routes and physical keys while preserving full scoped snapshot identity', () => {
        const pages = computeRtcTopologyPublicationOutbox(createPublication('work-one'));
        const message = decodePersistedALMessage(pages[0].resource);
        expect(message.route.resourceId.length).toBeLessThanOrEqual(128);
        expect(JSON.parse(assembleStateSnapshotMessages([message], createPublication('work-one').groupRef, 1000)[0].resource).groupRef)
            .toEqual(createPublication('work-one').groupRef);
        expect(pages[0].key.resourceId.length).toBeLessThanOrEqual(36);
        expect(message.targets).toMatchObject({ recipientPeerIds: ['session-0000'] });
    });

    it('assigns distinct physical keys to publications sharing one logical route', () => {
        const first = computeRtcTopologyPublicationOutbox(createPublication('work-one'))[0];
        const second = computeRtcTopologyPublicationOutbox(createPublication('work-two'))[0];
        expect(first.key).not.toEqual(second.key);
        expect(decodePersistedALMessage(first.resource).route).toEqual(decodePersistedALMessage(second.resource).route);
        expect(decodePersistedALMessage(first.resource).id.msgId).not.toBe(decodePersistedALMessage(second.resource).id.msgId);
    });

    it('publishes an oversized 1500-member topology to every frozen recipient without truncation', () => {
        const publication = createPublication('large-room', 1500);
        expect(new TextEncoder().encode(JSON.stringify(publication.snapshot)).length).toBeGreaterThan(64 * 1024);
        const messages = computeRtcTopologyPublicationOutbox(publication).map((page) => decodePersistedALMessage(page.resource));
        process.stdout.write(
            'SNAPSHOT-MEASUREMENT ' +
                JSON.stringify({
                    kind: 'topology',
                    members: 1500,
                    bytes: new TextEncoder().encode(JSON.stringify(publication.snapshot)).length,
                    envelopes: messages.length,
                    logicalPages: new Set(messages.map((message) => JSON.parse(message.payload.resource).index)).size
                }) + '\n'
        );
        const recipients = new Map<string, typeof messages>();
        for (const message of messages) {
            expect(new TextEncoder().encode(message.payload.resource).length).toBeLessThanOrEqual(64 * 1024);
            expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(128 * 1024);
            if (message.targets?.mode !== 'broadcast') {
                throw new Error('Expected frozen room broadcast');
            }
            expect(message.targets.recipientPeerIds!.length).toBeLessThanOrEqual(256);
            for (const peer of message.targets.recipientPeerIds!) {
                recipients.set(peer, [...(recipients.get(peer) ?? []), message]);
            }
        }
        expect([...recipients.keys()]).toEqual(publication.recipientSessionIds);
        const firstBatch = recipients.get('session-0000')!;
        expect(firstBatch.length).toBeGreaterThan(1);
        expect([...recipients.values()].every((pages) => pages.length === firstBatch.length)).toBe(true);
        for (const peer of ['session-0000', 'session-0256', 'session-1499']) {
            const snapshots = assembleStateSnapshotMessages(recipients.get(peer)!, publication.groupRef, 1000);
            expect(snapshots).toHaveLength(1);
            expect(JSON.parse(snapshots[0].resource)).toEqual(publication.snapshot);
        }
    });
});

function createPublication(workId: string, count = 1): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'medium-scale-application'.repeat(2),
        workspaceId: 'medium-scale-workspace'.repeat(2),
        groupId: 'medium-scale-group'.repeat(2)
    };
    const activeSessionIds = Array.from({ length: count }, (_, index) => `session-${String(index).padStart(4, '0')}`);
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: { groupRevision: 141, presenceRevision: 204 },
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Medium-scale group',
        topology: 'tree',
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(
            activeSessionIds.map((
                id,
                index
            ) => [id, activeSessionIds.slice(Math.max(0, index - 1), index).concat(activeSessionIds.slice(index + 1, index + 2))])
        ),
        degreeLimit: 2,
        version: 122,
        createdByClientId: 'owner',
        createdAtEpochMs: 1000,
        updatedAtEpochMs: 1000
    };
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef,
        sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 101,
        recipientSessionIds: activeSessionIds,
        snapshot,
        createdAtEpochMs: 1000,
        expiresAtEpochMs: 2000
    };
}
