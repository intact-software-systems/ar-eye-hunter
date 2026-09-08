import { computeGroupStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    createDeltaEnvelopeFixture,
    createDeltaEnvelopeFixtureGroupSnapshot,
    createDeltaEnvelopeFixtureWebSocketServer,
    DELTA_ENVELOPE_FIXTURE_GROUP_REF,
    DELTA_ENVELOPE_FIXTURE_NOW,
    readFixtureConnectionIds
} from '../../group-state/presence/group-state-delta-envelope-fixtures.ts';

const ALICE = { principalId: 'alice', sessionId: 'alice-session', role: 'owner' } as const;
const JOINING = { principalId: 'joining', sessionId: 'joining-session', role: 'member' } as const;

// The room-scope outbox dispatch path is the one production uses for group
// state sync rows. A delta-envelope row carries its own immutable audience, so
// it must reach the session whose change produced it even though no
// process-local snapshot names that session yet.
describe('room-scope broadcast delivery of persisted state-sync audiences', () => {
    it('delivers to the persisted audience without consulting a group snapshot', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'joining-session', 'stranger-session']);
        const resolver = createWsServerTargetResolver(server, {
            findGroupSnapshotByRef: () => createDeltaEnvelopeFixtureGroupSnapshot([ALICE]),
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });
        const envelope = createDeltaEnvelopeFixture({
            audienceSessionIds: ['alice-session', 'joining-session'],
            members: [ALICE, JOINING]
        });
        expect(() => validateGroupStateDeltaEnvelope(envelope)).not.toThrow();

        const recipients = resolver.resolveBroadcastRecipients?.('room', toRoomEnvelopeMessage(envelope));

        expect(readFixtureConnectionIds(recipients)).toEqual(['alice-session', 'joining-session']);
    });

    it('intersects the persisted audience with locally open connections only', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session']);
        const resolver = createWsServerTargetResolver(server, {
            findGroupSnapshotByRef: () => createDeltaEnvelopeFixtureGroupSnapshot([ALICE, JOINING]),
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });

        const recipients = resolver.resolveBroadcastRecipients?.(
            'room',
            toRoomEnvelopeMessage(
                createDeltaEnvelopeFixture({
                    audienceSessionIds: ['alice-session', 'remote-session'],
                    members: [ALICE, JOINING]
                })
            )
        );

        expect(readFixtureConnectionIds(recipients)).toEqual(['alice-session']);
    });

    it('delivers the persisted snapshot audience when the local snapshot is absent', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'joining-session', 'stranger-session']);
        const resolver = createWsServerTargetResolver(server, {
            findGroupSnapshotByRef: () => undefined,
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });
        const snapshot = createDeltaEnvelopeFixtureGroupSnapshot([ALICE, JOINING]);
        const entries = computeGroupStateSyncEntries({
            commandId: 'snapshot-command',
            aggregateRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF,
            acceptedCausalRevision: snapshot.causalRevision,
            audience: {
                kind: 'group',
                applicationId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.applicationId,
                workspaceId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.workspaceId,
                resourceId: DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId
            },
            createdAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW,
            expireAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW + 60_000,
            effects: [{ effectKind: 'member-state', payloadKind: 'snapshot', payload: snapshot }]
        }, 'rallar-server');

        const persistedAudiencePages = entries.map((entry) => decodePersistedALMessage(entry.resource))
            .filter((message) => message.targets?.mode === 'broadcast' && message.targets.recipientPeerIds !== undefined);
        expect(persistedAudiencePages.length).toBeGreaterThan(0);
        for (const message of persistedAudiencePages) {
            expect(message.targets).toMatchObject({
                mode: 'broadcast',
                scope: 'room',
                groupRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF,
                recipientPeerIds: ['alice-session', 'joining-session']
            });
            const recipients = resolver.resolveBroadcastRecipients?.('room', message);
            expect(readFixtureConnectionIds(recipients)).toEqual(['alice-session', 'joining-session']);
        }
    });

    it('rejects a persisted audience carried for a different group', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'foreign-session']);
        const resolver = createWsServerTargetResolver(server, {
            findGroupSnapshotByRef: () => createDeltaEnvelopeFixtureGroupSnapshot([ALICE]),
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });
        const foreignEnvelope = createDeltaEnvelopeFixture({
            audienceSessionIds: ['foreign-session'],
            members: [ALICE],
            groupId: 'other-room'
        });

        const recipients = resolver.resolveBroadcastRecipients?.(
            'room',
            newALBroadcastMessage(
                'rallar-server',
                newALEventRoute(AppTopics.groupStateEvent, DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId, 'event-foreign'),
                'room',
                AppTopics.groupStateEvent,
                foreignEnvelope,
                { groupRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF }
            )
        );

        expect(readFixtureConnectionIds(recipients)).toEqual([]);
    });
});

function toRoomEnvelopeMessage(envelope: GroupStateDeltaEnvelope): ALMessage {
    return newALBroadcastMessage(
        'rallar-server',
        newALEventRoute(AppTopics.groupStateEvent, DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId, envelope.event.eventId),
        'room',
        AppTopics.groupStateEvent,
        envelope,
        { groupRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF }
    );
}
