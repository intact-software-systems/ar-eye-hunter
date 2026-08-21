import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync-routing.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { validateGroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { describe, expect, it, vi } from 'vitest';
import {
    createDeltaEnvelopeFixture,
    createDeltaEnvelopeFixtureAuditStamp,
    createDeltaEnvelopeFixtureGroupEvent,
    createDeltaEnvelopeFixtureGroupSnapshot,
    createDeltaEnvelopeFixtureWebSocketServer,
    DELTA_ENVELOPE_FIXTURE_NOW
} from './group-state-delta-envelope-fixtures.ts';

describe('group-state delta envelope audience routing', () => {
    it('resolves recipients from the persisted audience without any cache lookup', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'bob-session', 'other-session']);
        const findGroupSnapshotByRef = vi.fn(() => createDeltaEnvelopeFixtureGroupSnapshot());
        const readClientSnapshots = vi.fn(() => [] as readonly ClientSnapshot[]);
        const envelope = createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session', 'bob-session'] });
        expect(() => validateGroupStateDeltaEnvelope(envelope)).not.toThrow();

        const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(envelope), {
            findGroupSnapshotByRef,
            readClientSnapshots,
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });

        expect(connectionIds(recipients)).toEqual(['alice-session', 'bob-session']);
        expect(findGroupSnapshotByRef).not.toHaveBeenCalled();
        expect(readClientSnapshots).not.toHaveBeenCalled();
    });

    it('drops audience sessions without a locally open connection silently', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session']);
        const envelope = createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session', 'ghost-session', 'bob-session'] });

        const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(envelope), {
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });

        expect(connectionIds(recipients)).toEqual(['alice-session']);
    });

    it('still resolves a bare legacy event row through the snapshot cache path', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session', 'bob-session']);
        const snapshot = createDeltaEnvelopeFixtureGroupSnapshot();
        const findGroupSnapshotByRef = vi.fn(() => snapshot);
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateEvent, 'room-1', 'event-1'),
            'all',
            AppTopics.groupStateEvent,
            createDeltaEnvelopeFixtureGroupEvent()
        );

        const recipients = resolveStateSyncRecipients(server, message, {
            findGroupSnapshotByRef,
            readClientSnapshots: () => [createClientSnapshot('alice', 'alice-session')],
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });

        expect(findGroupSnapshotByRef).toHaveBeenCalled();
        expect(connectionIds(recipients)).toEqual(['alice-session']);
    });

    it('treats a malformed envelope payload as invalid and resolves nobody', () => {
        const server = createDeltaEnvelopeFixtureWebSocketServer(['alice-session']);
        const envelope = createDeltaEnvelopeFixture({ audienceSessionIds: ['alice-session'] });
        const malformed = { ...envelope, onlineMemberCount: envelope.onlineMemberCount + 1 };

        const recipients = resolveStateSyncRecipients(server, createEnvelopeMessage(malformed), {
            now: () => DELTA_ENVELOPE_FIXTURE_NOW
        });

        expect(recipients).toEqual([]);
    });
});

function connectionIds(
    recipients: ReturnType<typeof resolveStateSyncRecipients>
): readonly string[] {
    return (recipients ?? []).map((recipient) => recipient.connectionId).sort();
}

/**
 * This suite exercises the non-room broadcast branch, so its rows carry scope
 * 'all'; the room-scope dispatch path has its own suite.
 */
function createEnvelopeMessage(envelope: GroupStateDeltaEnvelope) {
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.groupStateEvent, 'room-1', envelope.event.eventId),
        'all',
        AppTopics.groupStateEvent,
        envelope
    );
}

function createClientSnapshot(principalId: string, sessionId: string): ClientSnapshot {
    const audit = createDeltaEnvelopeFixtureAuditStamp();
    return {
        stateRevision: 1,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW
        },
        instances: [],
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId,
                clientInstanceId: 'browser',
                sessionId,
                generationId: `${sessionId}-generation`,
                generationVersion: 1,
                status: 'active',
                disconnectedAtEpochMs: null,
                disconnectReason: null,
                presenceState: 'online',
                transport: 'ws',
                connectionId: sessionId,
                authenticatedAtEpochMs: 1,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW,
                expiresAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW + 60_000
            }
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: DELTA_ENVELOPE_FIXTURE_NOW
    };
}
