import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { computeRoomLobbyPublication } from '@shared-server/rallar-system/group-state/lobby/room-lobby-publication.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { expect, it } from 'vitest';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'court' };
const facts = {
    roomRef, groupCreatedAtEpochMs: 1000, createdAtEpochMs: 2000, retentionMs: 60000,
    serviceId: 'api', traceId: 'trace'
};
const window = { generation: 5, dueAtEpochMs: 122000 };
const present = { principalId: 'bob', present: true, admissionWindow: null, returnWindow: null };
const alice = { ...present, principalId: 'alice', present: false };

it('publishes the changed private seat across rooms and persists one wake per newly opened window', () => {
    const before = { expiresAtEpochMs: null, activationId: 'enabled', revision: 4, seats: [alice, present] };
    const after = { expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }, present] };
    const result = computeRoomLobbyPublication({ ...facts, before, after });
    const entries = result.outbox.map(row => ({ row, message: decodePersistedALMessage(row.entry.resource) }));
    const notices = entries.filter(({ message }) => message.payload.typeId === AppTopics.viewInvalidated);
    expect(notices.map(({ message }) => decodeViewInvalidationMessage(message))).toEqual([
        expect.objectContaining({ resource: 'room-lobby', scope: { applicationId: 'app', workspaceId: 'workspace' }, principalId: 'alice' })
    ]);
    const deadlines = entries.filter(({ message }) => message.payload.typeId === AppOutboxType.ROOM_LOBBY_DEADLINE);
    expect(deadlines.map(({ row }) => row.entry.dequeueAudit.nextTs?.epochMilliseconds)).toEqual([122000]);
    expect(JSON.parse(deadlines[0]!.message.payload.resource)).toEqual({
        kind: 'seat', roomRef, activationId: 'enabled', groupCreatedAtEpochMs: 1000, generation: 5, dueAtEpochMs: 122000
    });
    expect(computeRoomLobbyPublication({ ...facts, before: after, after }).outbox).toEqual([]);
});

it('coalesces simultaneous return deadlines and notifies former holders when the lobby closes', () => {
    const away = { ...alice, principalId: 'chris', returnWindow: window };
    const after = { expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }, away] };
    const opened = computeRoomLobbyPublication({ ...facts, before: null, after });
    expect(opened.outbox.map(row => decodePersistedALMessage(row.entry.resource).payload.typeId).sort())
        .toEqual([AppOutboxType.ROOM_LOBBY_DEADLINE, AppTopics.viewInvalidated, AppTopics.viewInvalidated].sort());
    const closed = computeRoomLobbyPublication({ ...facts, before: after, after: null });
    expect(closed.outbox.map(row => decodeViewInvalidationMessage(decodePersistedALMessage(row.entry.resource)).principalId).sort())
        .toEqual(['alice', 'chris']);
});

it('schedules a replacement generation without notifying a participant whose visible deadline is unchanged', () => {
    const before = { expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }] };
    const after = { expiresAtEpochMs: null, activationId: 'enabled', revision: 6, seats: [{ ...alice, returnWindow: { ...window, generation: 6 } }] };
    const publication = computeRoomLobbyPublication({ ...facts, before, after });
    expect(publication.outbox.map(row => decodePersistedALMessage(row.entry.resource).payload.typeId))
        .toEqual([AppOutboxType.ROOM_LOBBY_DEADLINE]);
});

it('fences reenabled holds even when the same revision and deadline recur', () => {
    const occupied = { expiresAtEpochMs: null, activationId: 'enabled', revision: 5, seats: [{ ...alice, returnWindow: window }] };
    const first = computeRoomLobbyPublication({ ...facts, before: null, after: { ...occupied, activationId: 'first' } });
    const reopened = computeRoomLobbyPublication({ ...facts, before: null, after: { ...occupied, activationId: 'second' } });
    const oldIds = first.outbox.map(row => row.entry.key.resourceId);
    expect(reopened.outbox.map(row => row.entry.key.resourceId).filter(id => oldIds.includes(id))).toEqual([]);
});

it('persists a room closure without a seat timer, and schedules its new boundary on renewal', () => {
    const initial = { revision: 1, activationId: 'lobby', expiresAtEpochMs: 2100, seats: [present] };
    const renewed = { ...initial, expiresAtEpochMs: 3100, revision: 2 };
    for (const [before, after] of [[null, initial], [initial, renewed]] as const) {
        const publication = computeRoomLobbyPublication({ ...facts, before, after });
        const deadlines = publication.outbox.map(row => decodePersistedALMessage(row.entry.resource))
            .filter(message => message.payload.typeId === AppOutboxType.ROOM_LOBBY_DEADLINE);
        expect(deadlines.map(message => JSON.parse(message.payload.resource))).toEqual([
            { kind: 'room', roomRef, groupCreatedAtEpochMs: 1000, activationId: 'lobby', dueAtEpochMs: after.expiresAtEpochMs }
        ]);
    }
});
