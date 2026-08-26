import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync/state-sync-routing.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { describe, expect, it } from 'vitest';
import { createDeltaEnvelopeFixture, createDeltaEnvelopeFixtureWebSocketServer, DELTA_ENVELOPE_FIXTURE_NOW } from './group-state-delta-envelope-fixtures.ts';

describe('group-state delta envelope audience routing', () => {
    it('resolves recipients from the persisted audience without cache lookups', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer([
            'alice-session',
            'bob-session',
            'other-session'
        ]);
        const envelope = createDeltaEnvelopeFixture({
            audienceSessionIds: ['alice-session', 'bob-session']
        });
        expect(() => validateGroupStateDeltaEnvelope(envelope)).not.toThrow();

        const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(envelope), {
            findGroupSnapshotByRef: rejectUnexpectedGroupSnapshotRead,
            readClientSnapshots: rejectUnexpectedClientSnapshotRead,
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });

        expect(connectionIds(recipients)).toEqual(['alice-session', 'bob-session']);
    });

    it('silently drops audience sessions without a locally open connection', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session']);
        const envelope = createDeltaEnvelopeFixture({
            audienceSessionIds: ['alice-session', 'ghost-session', 'bob-session']
        });

        const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(envelope), {
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });

        expect(connectionIds(recipients)).toEqual(['alice-session']);
    });

    it('rejects malformed current envelopes', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session']);
        const envelope = createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session'] });
        const malformed = { ...envelope, onlineMemberCount: envelope.onlineMemberCount + 1 };

        expect(resolveStateSyncRecipients(server, createEnvelopeMessage(malformed), {
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        })).toEqual([]);
    });
});

function rejectUnexpectedGroupSnapshotRead(): never {
    throw new Error('Persisted delta audiences must not read a group snapshot');
}

function rejectUnexpectedClientSnapshotRead(): never {
    throw new Error('Persisted delta audiences must not read client snapshots');
}

function connectionIds(
    recipients: ReturnType<typeof resolveStateSyncRecipients>
): readonly string[] {
    return (recipients ?? []).map((recipient) => recipient.connectionId).sort();
}

function createEnvelopeMessage(envelope: GroupStateDeltaEnvelope) {
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(
            AppTopics.groupStateEvent,
            envelope.event.groupId,
            envelope.event.eventId
        ),
        'room',
        AppTopics.groupStateEvent,
        envelope,
        { groupRef: envelope.event }
    );
}
